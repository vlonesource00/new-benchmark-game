// P1 (approved): APEX's own pit planner, installed per entry through a TeamStrategist subclass (the mechanism SPH uses).
// The host still enforces everything physical (tank size, compounds, pit lane, service procedure); this only makes the calls
// the default strategist makes: start compound, box or stay, what the stop contains. Without a stint table for the track and
// class, or with a human in the team, every call falls through to the default strategist.
import { TeamStrategist, maxWear } from '../../../game/core/strategy.js';
import { TANK_LITRES, serviceTime } from '../../../game/core/rules.js';
import config from '../config.json' with { type: 'json' };
import { StintModel, COMPOUND_IDS, WARM, COLD } from './stintmodel.js';

const INF = 1e9, WEAR_SOFT = 0.9, WEAR_PENALTY = 600;
const coreOf = (car) => Math.max(...car.wheels.map((w) => w.tyre.core));

export class ApexStrategist extends TeamStrategist {
  constructor(previous, trackId, classId, options = {}) {
    super(previous.team, previous.cal, previous.format);
    Object.assign(this, previous);
    this.trackId = trackId; this.classId = classId; this.options = options;
    this.model = new StintModel(trackId, classId, this.cal);
    this.predicted = null;       // what the current set was predicted to do, to learn from the difference
    this.decisions = [];
  }
  get usable() { return this.model.ok && this.options.enabled !== false; }
  /**
   * Cheapest way to finish the race from the state after the lap in progress (or from lap 0 when `start`): dynamic programme over
   * laps, tyre set, laps of fuel, stops made and the swap. `cur` is the set the car is on: { c, t[], wear[] } = predicted next laps.
   */
  search({ n, cur, fuelLaps, stops, swaps, start = false }) {
    const m = this.model, cal = this.cal, fpl = this.fuelPerLap, fm = this.format, drivers = this.team.drivers.length;
    const needSwap = fm.mandatorySwap && drivers > 1, owed = fm.mandatoryStops;
    const fresh = COMPOUND_IDS.map((c) => m.fresh(c, n + 2));
    const memo = new Map();
    const fuelNow = (f) => (f + 0.15) * fpl;
    const endPen = (w) => Math.max(0, w - WEAR_SOFT) * WEAR_PENALTY;
    // after lap j on set (kind, a): kind 0..2 fresh set of that compound with a laps behind it, 3 the current set (a counts laps after the lap in progress)
    const nextT = (kind, a) => (kind === 3 ? cur.t[a] ?? INF : fresh[kind].t[a] ?? INF);
    const wearAt = (kind, a) => (kind === 3 ? (a === 0 ? cur.wear0 : cur.wear[a - 1]) : (a === 0 ? 0 : fresh[kind].wear[a - 1]));
    const V = (j, kind, a, f, s, sw) => {
      if (j >= n) return (s >= owed && (!needSwap || swaps > 0 || sw) ? 0 : INF) + endPen(wearAt(kind, a));
      const key = (((((j * 4 + kind) * 40 + a) * 16 + Math.min(15, f)) * 4 + Math.min(3, s)) * 2 + (sw ? 1 : 0));
      const hit = memo.get(key); if (hit !== undefined) return hit;
      let best = INF; const rem = n - j;
      if (f >= 1) { const t = nextT(kind, a); if (t < INF) best = t + V(j + 1, kind, a + 1, f - 1, s, sw); }
      if (rem >= 1 && s < 3) {
        const swap = needSwap && swaps === 0 && !sw, now = fuelNow(f), need = Math.min(TANK_LITRES, (rem + 0.35) * fpl);
        const litres = Math.max(0, Math.min(TANK_LITRES - now, need - now)), f2 = Math.floor(Math.min(TANK_LITRES, now + litres) / fpl - 0.15);
        const leave = endPen(wearAt(kind, a));
        if (f2 >= 1) {
          for (let c2 = 0; c2 < 3; c2++) {
            const svc = serviceTime(cal, { litres, tyres: true, swap }) + m.transit;
            best = Math.min(best, leave + svc + fresh[c2].t[0] + V(j + 1, c2, 1, f2 - 1, s + 1, sw || swap));
          }
          // fuel-only stop: keep the tyres
          if (kind === 3 || a >= 1) { const t = nextT(kind, a); if (t < INF) best = Math.min(best, serviceTime(cal, { litres, tyres: false, swap }) + m.transit + t + V(j + 1, kind, a + 1, f2 - 1, s + 1, sw || swap)); }
        }
      }
      memo.set(key, best); return best;
    };
    return { V, fresh, cur };
  }
  /** Root decision after the lap in progress: continue, or stop for (compound, tyres). Returns the cheapest first move. */
  root({ n, cur, fuelLaps, stops, swaps }) {
    const { V, fresh } = this.search({ n, cur, fuelLaps, stops, swaps });
    const fm = this.format, drivers = this.team.drivers.length, needSwap = fm.mandatorySwap && drivers > 1, fpl = this.fuelPerLap, m = this.model;
    const j = 1, rem = n - j, f = fuelLaps;
    const out = { cont: f >= 1 ? cur.t[0] + V(j + 1, 3, 1, f - 1, stops, false) : INF, stops: [] };
    if (rem >= 1) {
      const swap = needSwap && swaps === 0, now = (f + 0.15) * fpl, need = Math.min(TANK_LITRES, (rem + 0.35) * fpl), litres = Math.max(0, Math.min(TANK_LITRES - now, need - now)), f2 = Math.floor(Math.min(TANK_LITRES, now + litres) / fpl - 0.15);
      if (f2 >= 1) for (let c2 = 0; c2 < 3; c2++) {
        const svc = serviceTime(this.cal, { litres, tyres: true, swap }) + m.transit;
        out.stops.push({ compound: COMPOUND_IDS[c2], tyres: true, litres, swap, cost: Math.max(0, cur.wear[0] ?? 0) * 0 + svc + fresh[c2].t[0] + V(j + 1, c2, 1, f2 - 1, stops + 1, swap || swaps > 0) });
      }
    }
    return out;
  }
  /** Predicted next laps of the car's own set, from its measured state. */
  curSet(car, n) {
    const c = car.wheels[0].tyre.compound, wear0 = maxWear(car);
    const r = this.model.roll(c, n + 2, { age0: this.stintLaps + 1, wear0, core0: coreOf(car), warm: this.stops > 0 });
    return { c, t: r.t, wear: r.wear, wear0 };
  }
  startCompound() {
    if (!this.usable) return super.startCompound();
    const n = this.cal.laps, fuelLaps = Math.floor(TANK_LITRES / this.fuelPerLap - 0.15);
    let best = { cost: INF, c: 'medium' };
    for (const c of COMPOUND_IDS) {
      const r = this.model.roll(c, n + 2, { core0: COLD });
      const cur = { c, t: r.t.slice(1), wear: r.wear.slice(1), wear0: r.wear[0] };
      const { V } = this.search({ n, cur, fuelLaps: fuelLaps - 1, stops: 0, swaps: 0 });
      const cost = r.t[0] + V(1, 3, 0, fuelLaps - 1, 0, false);
      if (cost < best.cost) best = { cost, c };
    }
    this.decisions.push({ at: 'start', compound: best.c, cost: +best.cost.toFixed(1) });
    return best.c;
  }
  decide(car, lapsLeft, aiDriving = true) {
    if (!this.usable || !aiDriving || this.request || car.race.lap < 1) return super.decide(car, lapsLeft, aiDriving);
    if (lapsLeft <= 1) { this.boxThisLap = false; this.reason = 'FINAL LAP'; return (this.plan = null); }
    const n = lapsLeft, fuelLaps = Math.floor(car.fuel / this.fuelPerLap - 0.15);
    const cur = this.curSet(car, n), r = this.root({ n, cur, fuelLaps, stops: this.stops, swaps: this.swaps });
    const best = r.stops.reduce((b, s) => (s.cost < b.cost ? s : b), { cost: INF });
    const box = best.cost < r.cont - 0.05 || r.cont >= INF;
    this.decisions.push({ lap: car.race.lap, left: lapsLeft, cont: +r.cont.toFixed(1), stop: best.cost < INF ? +best.cost.toFixed(1) : null, compound: best.compound, box });
    if (!box) {
      // physical safety net the planner may not see: do not run past what the fuel or the tyres can take
      const fuelOut = car.fuel / this.fuelPerLap < 1.05 && lapsLeft > 1, dead = maxWear(car) > 0.96;
      if (fuelOut || dead) {
        this.boxThisLap = true; this.reason = fuelOut ? 'FUEL' : 'TYRES';
        const fresh = this.root({ n, cur, fuelLaps: Math.max(1, fuelLaps), stops: this.stops, swaps: this.swaps }).stops.reduce((b, s) => (s.cost < b.cost ? s : b), { cost: INF });
        this.chosen = { ...fresh, compound: fresh.compound ?? 'hard', swap: fresh.swap ?? false };
        return (this.plan = this.fit(car, lapsLeft - 1, this.chosen));
      }
      this.boxThisLap = false; this.reason = ''; return (this.plan = null);
    }
    this.boxThisLap = true; this.reason = 'APEX PLAN';
    this.chosen = { ...best, after: lapsLeft - 1 };
    return (this.plan = this.fit(car, lapsLeft - 1, best));
  }
  fit(car, after, best) {
    const need = Math.min(TANK_LITRES, (after + 0.35) * this.fuelPerLap);
    return { litres: Math.max(0, Math.min(TANK_LITRES - car.fuel, need - car.fuel)), tyres: true, compound: best.compound, swap: best.swap };
  }
  servicePlan(car, after) {
    if (!this.usable || this.request || !this.chosen) return super.servicePlan(car, after);
    const c = this.chosen; this.chosen = null;
    return this.fit(car, after, c);
  }
  /** Learn from the lap just driven: how fast this set wears, how hot it runs, how much slower or faster than predicted. */
  observeLap(car, clean) {
    const before = this.lapMark?.wear ?? null;
    super.observeLap(car, clean);
    if (!this.usable || !clean || before === null) return;
    const now = maxWear(car), dw = now - before, id = car.wheels[0].tyre.compound, age = this.stintLaps;
    const pred = this.model.roll(id, 1, { age0: age - 1, wear0: before, core0: coreOf(car), warm: this.stops > 0 });
    const dwPred = pred.wear[0] - before;
    if (dwPred > 0.01 && now < 0.95) {
      const a = this.model.adapt, k = Math.min(1.8, Math.max(0.55, dw / dwPred));
      a.wear = Math.min(1.8, Math.max(0.55, a.wear * (1 + 0.5 * (k - 1))));
    }
  }
  stopDone(plan) { super.stopDone(plan); this.chosen = null; }
}

export function installApexStrategy(race, car, { enabled = config.strategy ?? true } = {}) {
  if (!enabled || race.session !== 'race') return false;
  const e = race.entryOf?.(car);
  if (!e || e.strategist instanceof ApexStrategist || e.strategist.stintLaps > 0 || e.strategist.stops > 0) return false;
  if (!e.team.drivers.every((d) => d.kind === 'ai' && d.id === 'apex')) return false;
  e.strategist = new ApexStrategist(e.strategist, race.track.id, car.classId);
  return true;
}
