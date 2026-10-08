import { COMPOUNDS, COMPOUND_IDS, TYRES, TYRE_IDS, WET_COMPOUNDS, TANK_LITRES, WEAR_CLIFF, CROSSOVER } from './rules.js';

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
    // (cars at race pace wear ~1.5x the calibration's nominal rate: the estimate starts there and is learnt from the car)
    this.wearPerLap = { ...Object.fromEntries(Object.values(TYRES).map((c) => [c.id, WEAR_INIT * WEAR_CLIFF * c.wear / cal.tyreLaps])) };
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
    // How much harder than the wear model each compound has faded for this car (learnt per stint, 1 = as modelled).
    this.fade = Object.fromEntries(TYRE_IDS.map((id) => [id, 1]));
    this.stintTimes = [];
  }
  /** Laps until the compound is fully worn (the cost model prices the cliff before that). */
  compoundLife(id) { return 1 / this.wearRate(id); }
  /** Wear per lap the planner uses: aggressive teams count on a little less, careful ones on a little more. */
  wearRate(id) { return this.wearPerLap[id] * (1 - 0.1 * this.style.aggression); }
  /** Called when the car completes a lap (not an in/out lap). */
  observeLap(car, clean) {
    const now = { fuel: car.fuel, wear: maxWear(car) };
    this.lastLap = clean ? car.race.lastLap : null;
    if (clean && (this.stintBest === null || car.race.lastLap < this.stintBest)) this.stintBest = car.race.lastLap;
    if (clean) { this.stintTimes.push([this.stintLaps, car.race.lastLap, now.wear]); this.lapRef = this.lapRef * 0.7 + car.race.lastLap * 0.3; this.learnDeg(car.wheels[0].tyre.compound); }
    if (this.lapMark && clean) {
      const fuel = this.lapMark.fuel - now.fuel, wear = now.wear - this.lapMark.wear;
      if (fuel > 0) this.fuelPerLap = this.fuelPerLap * 0.5 + fuel * 0.5;
      const id = car.wheels[0].tyre.compound;
      if (wear > 0) this.wearPerLap[id] = this.wearPerLap[id] * 0.5 + wear * 0.5;
    }
    this.lapMark = now; this.stintLaps += 1;
  }
  resetMark() { this.lapMark = null; this.stintLaps = 0; this.stintBest = null; this.lastLap = null; this.stintTimes = []; }
  /**
   * Learns how much harder this compound fades than the wear model says: this stint's lap-time loss from its best
   * lap against the model's loss at the same wear (needs a few laps and some wear before it says anything).
   */
  learnDeg(id) {
    const t = this.stintTimes, n = t.length;
    if (n < 3) return;
    const best = Math.min(...t.map((x) => x[1])), [, last, w] = t[n - 1], model = this.lapRef * WEAR_K * wearLoss(w);
    if (model < 0.3) return;
    this.fade[id] = clamp(this.fade[id] * 0.7 + ((last - best) / model) * 0.3, 0.5, 2.5);
  }
  /** Seconds per lap compound `id` is off a fresh medium when new (measured: soft -2 %, hard +3 %, the hard running cooler). */
  offset(id) { return this.lapRef * COMPOUND_PACE[id]; }
  /** Seconds the next `laps` laps take over fresh-medium pace on compound `id` already `age` laps old. */
  stintCost(id, age, laps) {
    if (laps <= 0) return 0;
    const r = this.wearRate(id), k = this.lapRef * WEAR_K * this.fade[id];
    let cost = laps * this.offset(id) + (age === 0 ? OUT_LAP_S : 0);
    for (let j = 0; j < laps; j++) cost += k * wearLoss(Math.min(1, (age + j + 0.5) * r));
    return cost;
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
  /**
   * Weather call: the tyre family the road needs over the next lap or two ('slick' | 'intermediate' | 'wet'), from the
   * road's mean wetness and where the rain is heading. Rain on the circuit pushes the call wetter; a drying road with
   * cars on it has a dry line well ahead of the mean, so the call goes drier. Hysteresis (0.05 past each crossover)
   * keeps a car from boxing back and forth around one. Returns null without race weather (bare tracks, rigs).
   */
  weatherNeed(car) {
    const env = this.env; if (!env?.track) return null;
    const have = WET_COMPOUNDS[car.wheels[0].tyre.compound] ? car.wheels[0].tyre.compound : 'slick';
    const mmh = env.weather?.snapshot ? env.weather.rainAt(env.weather.centre.x, env.weather.centre.z) : 0;
    const trend = (env.track.wetness ?? 0) - (this.lastWet ?? env.track.wetness ?? 0); this.lastWet = env.track.wetness;
    let w = (env.track.wetness ?? 0) + (mmh > 4 ? Math.min(0.18, mmh / 60) : 0) - (mmh < 0.5 && trend <= 0 ? 0.12 : 0);
    const order = ['slick', 'intermediate', 'wet'], at = order.indexOf(have), m = 0.05;
    let call = w < CROSSOVER.slickMax - (at > 0 ? m : -m) ? 'slick' : w < CROSSOVER.wetMin + (at === 2 ? -m : m) ? 'intermediate' : 'wet';
    // Rain falling (or a front building up) never sends a car to a drier family: the road is about to get wetter.
    const coming = mmh >= 1 || env.weather?.phase === 'building' || env.weather?.phase === 'shower';
    if (coming && order.indexOf(call) < at) call = have;
    return { call, have, wet: w, severe: Math.abs(order.indexOf(call) - at) > 1 || (have === 'slick' && w > 0.55) || (have !== 'slick' && w < 0.12) };
  }
  /** The rain tyre (or the slick for the stint) a weather stop fits. */
  weatherCompound(call, stintLaps) { return call === 'slick' ? this.pickCompound(stintLaps) : call; }
  /** Shared by subclass strategists: a plan when the weather alone says box (null otherwise). */
  weatherCall(car, lapsLeft) {
    const need = this.weatherNeed(car);
    if (!need || need.call === need.have || lapsLeft <= 1 || (lapsLeft <= 2 && !need.severe)) return null;
    this.boxThisLap = true; this.reason = `WEATHER · ${need.call.toUpperCase()}`;
    const plan = this.servicePlan(car, lapsLeft - 1);
    return this.plan = { ...plan, tyres: true, compound: this.weatherCompound(need.call, Math.max(1, Math.floor(TANK_LITRES / this.fuelPerLap))) };
  }
  decide(car, lapsLeft, aiDriving = true, caution = false) {
    const fuelLaps = car.fuel / this.fuelPerLap, wear = maxWear(car);
    const id = car.wheels[0].tyre.compound;
    const reasons = [];
    if (lapsLeft <= 1 && !this.request) { this.boxThisLap = false; this.reason = 'FINAL LAP'; return this.plan = null; }
    // Weather first: the wrong tyre family costs seconds a lap, far more than any stint plan saves.
    if (aiDriving && !this.request) { const w = this.weatherCall(car, lapsLeft); if (w) return w; }
    // On rain tyres (or a road that wants them) the dry-stint planner does not apply: only fuel, wear and the rules.
    const rainy = Boolean(WET_COMPOUNDS[id]) || (this.weatherNeed(car)?.call ?? 'slick') !== 'slick';
    // Box now when the car cannot complete the next full lap with margin.
    if (fuelLaps < 1.15 && fuelLaps < lapsLeft - 0.9) reasons.push('FUEL');
    // Undercut: box a lap or two early when one tank still reaches the flag.
    else if (aiDriving && this.style.undercut > 0 && this.stops < this.format.mandatoryStops && fuelLaps < 1.15 + this.style.undercut
      && fuelLaps < lapsLeft - 0.9 && (lapsLeft - 1 + 0.35) * this.fuelPerLap <= TANK_LITRES) reasons.push('UNDERCUT');
    const owed = Math.max(0, this.format.mandatoryStops - this.stops);
    if (wear + this.wearPerLap[id] * 1.05 > WEAR_CLIFF + 0.05 && lapsLeft > 1) reasons.push('TYRES');
    // Race planner: an AI boxes when stopping now beats every later stop, extra
    // stops for fresh softs included (the old PACE rule only looked back).
    else if (aiDriving && !rainy && lapsLeft - 1 >= 2 && this.planStint(car, lapsLeft - 1, owed).laps === 0) reasons.push('PLAN');
    if (owed > 0 && lapsLeft - 1 <= owed * 1) reasons.push('MANDATORY');
    if (this.format.mandatorySwap && this.swaps === 0 && lapsLeft - 1 <= 1 && this.team.drivers.length > 1) reasons.push('SWAP RULE');
    // Under caution the field is slow, so a stop costs a fraction of a green-flag one: box when stopping now at that
    // price beats the best plan from here (which pays full price for every later stop). A car that has just been in
    // gains nothing and stays out; one that still owes a stop, or is due one soon, takes the cheap one.
    if (caution && aiDriving && !rainy && !reasons.length && lapsLeft - 1 >= 2) {
      const n = lapsLeft - 1, stay = this.planStint(car, n, owed).cost;
      if (this.stopLoss - this.cautionSaving(caution) + this.planFresh(n, Math.max(0, owed - 1)).cost < stay - 0.5) reasons.push('CAUTION');
    }
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
    let tyres = this.reason.includes('PLAN') || this.reason.includes('CAUTION') || wear + this.wearPerLap[id] * stintLaps > WEAR_CLIFF + 0.04 || wear > 0.4 || (fresh && fresh.cost + this.cal.tyreChangeS < keep);
    let compound = id;
    if (tyres) compound = fresh ? fresh.id : this.pickCompound(stintLaps);
    // A wet road keeps (or fits) the rain tyre it calls for; the slick planner above only knows dry stints.
    const wx = this.weatherNeed?.(car);
    if (wx && wx.call !== 'slick') { if (WET_COMPOUNDS[id] && id === wx.call) { tyres = wear > 0.45; compound = id; } else { tyres = true; compound = wx.call; } }
    else if (tyres && WET_COMPOUNDS[compound]) compound = this.pickCompound(stintLaps);
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
  /** Seconds a stop saves when taken under caution (`kind` 'fcy' or 'sc'): the lane costs less against a field at 80 km/h, and next to nothing against a queue behind the safety car. */
  cautionSaving(kind) { return PIT_LANE_LOSS_S * (kind === 'sc' ? 0.75 : 0.5); }
  /** Compound an all-AI team starts on: the planner's first stint for the whole race. */
  startCompound() {
    this.memo = null;
    const need = this.env ? this.weatherNeed({ wheels: [{ tyre: { compound: 'medium' } }] }) : null;
    if (need && need.call !== 'slick') return need.call;
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
// Planner model, fitted to scripts/strategy/stint-rig.mjs stints (RAZOR, GTP and GT3, three tracks): a fresh soft is
// ~2 % quicker than a medium and a hard ~3 % slower (it also runs cooler); after that lap time follows the tread,
// losing about half of the grip wearGrip() takes away (gentle to 72 % wear, then the cliff). Out-lap on cold tyres ~1 s.
const COMPOUND_PACE = { soft: -0.016, medium: 0, hard: 0.022, intermediate: 0.05, wet: 0.09 };  // fresh-tyre pace vs medium, stint-rig 2026-10
const WEAR_K = 0.45, WEAR_INIT = 1.1;
const OUT_LAP_S = 1;
/** Fraction of grip lost at tread wear `w` (the tyre model's wearGrip). */
const wearLoss = (w) => 0.10 * w + 1.2 * Math.max(0, w - 0.72) ** 2;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function maxWear(car) { return Math.max(...car.wheels.map((w) => w.tyre.wear)); }
