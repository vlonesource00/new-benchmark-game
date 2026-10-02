import { COMPOUNDS, COMPOUND_IDS, TANK_LITRES, WEAR_CLIFF } from './rules.js';

/**
 * One strategist per team. It measures real fuel burn and tyre wear per lap
 * from the car, then decides at each lap's decision point whether to box and
 * what the stop contains. Human teams get the same advice and can override it
 * (box request, compound, swap, fuel).
 */
export class TeamStrategist {
  constructor(team, cal, format, seed = 7, index = 0) {
    this.team = team; this.cal = cal; this.format = format;
    this.style = strategyStyle(seed, index);
    this.fuelPerLap = cal.lapFuel;
    this.wearPerLap = { ...Object.fromEntries(Object.values(COMPOUNDS).map((c) => [c.id, WEAR_CLIFF * c.wear / cal.tyreLaps])) };
    this.stops = 0; this.swaps = 0; this.boxThisLap = false; this.reason = '';
    this.request = null;           // human override: { compound, swap, fuel }
    this.lapMark = null;
    this.stintLaps = 0;
    this.stintBest = null; this.lastLap = null;
    // Time a tyre stop costs over staying out: lane transit plus the change itself.
    this.stopLoss = (PIT_LANE_LOSS_S + cal.baseStopS + cal.tyreChangeS) * this.style.patience;
    // Race-planner model: seconds per lap each compound is off a medium, and
    // seconds per lap it fades with every lap of age (learnt from the stint).
    this.lapRef = cal.refLap ?? 70;
    this.deg = Object.fromEntries(Object.values(COMPOUNDS).map((c) => [c.id, DEG_MEDIUM * c.wear ** 0.9]));
    this.stintTimes = [];
  }
  compoundLife(id) { return (WEAR_CLIFF + 0.06) / this.wearPerLap[id]; }
  /** Called when the car completes a lap (not an in/out lap). */
  observeLap(car, clean) {
    const now = { fuel: car.fuel, wear: maxWear(car) };
    this.lastLap = clean ? car.race.lastLap : null;
    if (clean && (this.stintBest === null || car.race.lastLap < this.stintBest)) this.stintBest = car.race.lastLap;
    if (clean) { this.stintTimes.push([this.stintLaps, car.race.lastLap]); this.lapRef = this.lapRef * 0.7 + car.race.lastLap * 0.3; this.learnDeg(car.wheels[0].tyre.compound); }
    if (this.lapMark && clean) {
      const fuel = this.lapMark.fuel - now.fuel, wear = now.wear - this.lapMark.wear;
      if (fuel > 0) this.fuelPerLap = this.fuelPerLap * 0.5 + fuel * 0.5;
      const id = car.wheels[0].tyre.compound;
      if (wear > 0) this.wearPerLap[id] = this.wearPerLap[id] * 0.5 + wear * 0.5;
    }
    this.lapMark = now; this.stintLaps += 1;
  }
  resetMark() { this.lapMark = null; this.stintLaps = 0; this.stintBest = null; this.lastLap = null; this.stintTimes = []; }
  /** Least-squares fade of this stint's clean laps against tyre age. */
  learnDeg(id) {
    const t = this.stintTimes, n = t.length;
    if (n < 3) return;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of t) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const slope = (n * sxy - sx * sy) / Math.max(1e-6, n * sxx - sx * sx);
    this.deg[id] = this.deg[id] * 0.6 + Math.min(3, Math.max(0.02, slope)) * 0.4;
  }
  /** Seconds per lap compound `id` is off a medium (grip, scaled by team aggression). */
  offset(id) { return this.lapRef * COMPOUND_PACE * (1 - COMPOUNDS[id].grip) * (1 + 0.25 * this.style.aggression); }
  stintCost(id, age, laps) {
    if (laps <= 0) return 0;
    return laps * this.offset(id) + this.deg[id] * (laps * age + laps * (laps - 1) / 2) + (age === 0 ? OUT_LAP_S : 0);
  }
  /**
   * Cheapest way to run `n` more laps from fresh tyres with `owed` stops still
   * required: compound and length of each stint, tyre stops at `stopLoss`.
   * Stints are capped by a full tank and by the compound's wear life.
   */
  planFresh(n, owed) {
    const key = n * 8 + owed;
    this.memo ??= new Map();
    if (this.memo.has(key)) return this.memo.get(key);
    let best = { cost: Infinity, id: 'medium', laps: n };
    const tank = Math.max(1, Math.floor(TANK_LITRES / this.fuelPerLap));
    for (const id of COMPOUND_IDS) {
      const life = Math.max(1, Math.floor(this.compoundLife(id)));
      for (let L = 1; L <= Math.min(n, tank, life); L++) {
        let cost = this.stintCost(id, 0, L);
        if (L < n) cost += this.stopLoss + this.planFresh(n - L, Math.max(0, owed - 1)).cost;
        else if (owed > 0) continue;
        if (cost < best.cost) best = { cost, id, laps: L };
      }
    }
    this.memo.set(key, best);
    return best;
  }
  /** Best number of further laps on the current tyres (0 = box now) over `n` laps to go. */
  planStint(car, n, owed) {
    this.memo = null;
    const id = car.wheels[0].tyre.compound, age = this.stintLaps + 1;
    // Called near the end of a lap: the fuel left is (almost) all for laps to come.
    const fuel = Math.floor(car.fuel / this.fuelPerLap - 0.15);
    const life = Math.floor(this.compoundLife(id) - this.stintLaps - 1);
    let best = { cost: Infinity, laps: 0 };
    for (let x = 0; x <= Math.min(n, Math.max(0, fuel), Math.max(0, life)); x++) {
      let cost = this.stintCost(id, age, x);
      if (x < n) cost += this.stopLoss + this.planFresh(n - x, Math.max(0, owed - 1)).cost;
      else if (owed > 0) continue;
      if (cost < best.cost) best = { cost, laps: x };
    }
    return best;
  }
  /**
   * Seconds per lap the current tyres are down on this stint's best: heat and
   * wear both show up here, and neither recovers without new rubber.
   */
  paceLoss() { return this.lastLap !== null && this.stintBest !== null && this.stintLaps >= 3 ? this.lastLap - this.stintBest : 0; }
  /**
   * Decision for the lap about to reach the pit approach. `lapsLeft` counts
   * laps still to complete including the current one.
   */
  decide(car, lapsLeft, aiDriving = true) {
    const fuelLaps = car.fuel / this.fuelPerLap, wear = maxWear(car);
    const id = car.wheels[0].tyre.compound;
    const reasons = [];
    if (lapsLeft <= 1 && !this.request) { this.boxThisLap = false; this.reason = 'FINAL LAP'; return this.plan = null; }
    // Box now when the car cannot complete the next full lap with margin.
    if (fuelLaps < 1.15 && fuelLaps < lapsLeft - 0.9) reasons.push('FUEL');
    // Undercut: box a lap or two early when one tank still reaches the flag.
    else if (aiDriving && this.style.undercut > 0 && this.stops < this.format.mandatoryStops && fuelLaps < 1.15 + this.style.undercut
      && fuelLaps < lapsLeft - 0.9 && (lapsLeft - 1 + 0.35) * this.fuelPerLap <= TANK_LITRES) reasons.push('UNDERCUT');
    const owed = Math.max(0, this.format.mandatoryStops - this.stops);
    if (wear + this.wearPerLap[id] * 1.05 > WEAR_CLIFF + 0.05 && lapsLeft > 1) reasons.push('TYRES');
    // Race planner: an AI boxes when stopping now beats every later stop, extra
    // stops for fresh softs included (the old PACE rule only looked back).
    else if (aiDriving && lapsLeft - 1 >= 2 && this.planStint(car, lapsLeft - 1, owed).laps === 0) reasons.push('PLAN');
    if (owed > 0 && lapsLeft - 1 <= owed * 1) reasons.push('MANDATORY');
    if (this.format.mandatorySwap && this.swaps === 0 && lapsLeft - 1 <= 1 && this.team.drivers.length > 1) reasons.push('SWAP RULE');
    if (this.request) reasons.push('CALLED IN');
    this.boxThisLap = reasons.length > 0;
    this.reason = reasons.join(' + ');
    this.plan = this.boxThisLap ? this.servicePlan(car, lapsLeft - 1) : null;
    return this.plan;
  }
  /** What the stop contains; `after` = laps to run after the stop. */
  servicePlan(car, after) {
    const need = Math.min(TANK_LITRES, (after + 0.35) * this.fuelPerLap);
    let litres = Math.max(0, need - car.fuel);
    const wear = maxWear(car), id = car.wheels[0].tyre.compound;
    const stintLaps = Math.min(after, Math.max(1, Math.floor(TANK_LITRES / this.fuelPerLap)));
    this.memo = null;
    const owed = Math.max(0, this.format.mandatoryStops - this.stops - 1);
    const fresh = after > 0 ? this.planFresh(after, owed) : null;
    // Fresh rubber when the cliff is near, or when the plan from new tyres
    // (change time included) beats running on: a fuel stop is a cheap tyre stop.
    const keep = after > 0 ? this.stintCost(id, this.stintLaps + 1, Math.min(after, stintLaps)) + (after > stintLaps ? this.stopLoss + this.planFresh(after - stintLaps, Math.max(0, owed - 1)).cost : 0) : 0;
    let tyres = this.reason.includes('PLAN') || wear + this.wearPerLap[id] * stintLaps > WEAR_CLIFF + 0.04 || wear > 0.4 || (fresh && fresh.cost + this.cal.tyreChangeS < keep);
    let compound = id;
    if (tyres) compound = fresh ? fresh.id : this.pickCompound(stintLaps);
    const drivers = this.team.drivers.length;
    let swap = drivers > 1 && (this.format.mandatorySwap && this.swaps === 0 || this.team.drivers.every((d) => d.kind === 'ai') || this.stintBalanced());
    const r = this.request;
    if (r) {
      if (r.compound) { tyres = r.compound !== 'none'; compound = tyres ? r.compound : id; }
      if (r.swap !== undefined && r.swap !== null) swap = r.swap && drivers > 1;
      if (r.fuel !== undefined && r.fuel !== null) litres = Math.max(0, Math.min(TANK_LITRES - car.fuel, r.fuel));
    }
    return { litres, tyres, compound, swap };
  }
  /**
   * Softest compound that lasts the stint with this team's margin: aggressive
   * teams stretch a soft, conservative ones take a step harder than needed.
   */
  pickCompound(stintLaps) {
    const ids = ['soft', 'medium', 'hard'], a = this.style.aggression;
    let i = ids.findIndex((c) => this.compoundLife(c) >= stintLaps * (1.05 - 0.15 * a));
    if (i < 0) return 'hard';
    if (a < -0.4 && i < 2) i += 1;
    return ids[i];
  }
  /** Compound an all-AI team starts on: the planner's first stint for the whole race. */
  startCompound() {
    this.memo = null;
    return this.planFresh(this.cal.laps, this.format.mandatoryStops).id;
  }
  // Human-led teams hand the car to the AI for the middle stint of long races.
  stintBalanced() { return this.stintLaps >= Math.ceil(this.cal.laps / 2); }
  stopDone(plan) { this.stops += 1; if (plan.swap) this.swaps += 1; this.request = null; this.boxThisLap = false; this.resetMark(); }
}

/**
 * Per-team strategy personality, fixed by the race seed: how much margin the
 * team wants on a tyre (`aggression`, -1..1), how long it tolerates a fading
 * stint before boxing (`patience`, scales the PACE trigger) and how many laps
 * early it will come in for its stop (`undercut`). Rotating through three base
 * styles keeps any six-team grid split across strategies.
 */
export function strategyStyle(seed, index) {
  let h = (Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(index + 1, 0xc2b2ae35)) >>> 0;
  const rnd = () => { h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0; h = (h ^ (h + Math.imul(h ^ (h >>> 7), 0x297a2d39))) >>> 0; return ((h ^ (h >>> 14)) >>> 0) / 4294967296; };
  const base = [{ aggression: 0.8, patience: 0.75, undercut: 2.6 }, { aggression: 0, patience: 1, undercut: 1.1 }, { aggression: -0.8, patience: 1.35, undercut: 0 }][(Math.floor(rnd() * 3) + index) % 3];
  return {
    aggression: Math.max(-1, Math.min(1, base.aggression + (rnd() - 0.5) * 0.4)),
    patience: base.patience * (0.9 + rnd() * 0.2),
    undercut: Math.max(0, base.undercut + (rnd() - 0.5) * 0.8)
  };
}

// Lane transit over a racing lap at the same spot, measured on Harbor Ring.
export const PIT_LANE_LOSS_S = 18;
// Planner model, from 12-lap Solenne races: lap time moves ~0.18 x the grip
// difference (soft 1.3 s up on hard), a medium fades ~0.25 s per lap of age, and
// an out-lap on cold tyres costs about a second.
const COMPOUND_PACE = 0.18;
const DEG_MEDIUM = 0.25;
const OUT_LAP_S = 1;

export function maxWear(car) { return Math.max(...car.wheels.map((w) => w.tyre.wear)); }
