import { TeamStrategist, maxWear } from '../../../game/core/strategy.js';
import { COMPOUNDS, WEAR_CLIFF } from '../../../game/core/rules.js';
import { clamp } from './math.js';

/** Co-state hybrid energy deployment: maximizes corner-exit acceleration and combat slingshots while tapering at top speed. */
export function deployment(soc, v, { finish = false, fight = false, exit = false, throttle = 0, brake = 0, source = 'profile', green = true } = {}) {
  const max = finish || fight ? 1 : clamp(0.7 + (soc - 0.55) * 2.5, 0.1, 1),
    taper = clamp((78 - v) / 38, 0, 1);
  const burst = Boolean(fight && exit && throttle > 0.75 && brake < 0.01 && source !== 'nose' && soc > 0.16 && green);
  return { deploy: (burst ? 1 : max * taper * (exit ? 1 : 0.5)) * clamp(soc / 0.09, 0, 1), burst };
}

/** Live stint planner on the shared game's current compounds and circuit-specific pit-lane loss. */
export class VanguardStrategist extends TeamStrategist {
  constructor(previous, trackId, classId, lane = null) {
    super(previous.team, previous.cal, previous.format);
    Object.assign(this, previous);
    this.trackId = trackId;
    this.classId = classId;
    this.nextTyreLap = null;
    this.decisions = [];
    this.wheelRates = new Map();
    this.style = { aggression: 0.3, patience: 1, undercut: 0 };
    const referenceSpeed = (lane?.L ?? 0) / Math.max(1, this.lapRef);
    this.laneLoss = lane ? Math.max(10, lane.length / lane.limit - lane.length / Math.max(20, referenceSpeed)) : 18;
    const swap = this.team.drivers.length > 1 && (this.format.mandatorySwap || this.team.drivers.every(d => d.kind === 'ai')) ? this.cal.swapS : 0;
    this.stopLoss = this.laneLoss + this.cal.baseStopS + this.cal.tyreChangeS + swap;
  }
  wearRate(id) { return Math.max(0.005, this.wearPerLap[id]) * 1.06; }
  stintCost(id, age, laps) {
    const compound = COMPOUNDS[id];
    if (!compound) return super.stintCost(id, age, laps);
    const offset = this.lapRef * 0.55 * (1 - compound.grip), rate = this.wearRate(id), fade = this.fade[id] ?? 1;
    let cost = laps * offset + (age === 0 ? 0.7 : 0);
    for (let j = 0; j < laps; j++) {
      const w = Math.min(1, (age + j + 0.5) * rate), loss = 0.1 * w + 1.2 * Math.max(0, w - WEAR_CLIFF) ** 2;
      cost += this.lapRef * 0.45 * fade * loss;
      if (this.lapRef * 0.45 * fade * loss > 4) cost += (this.lapRef * 0.45 * fade * loss - 4) * 1.5;
    }
    return cost;
  }
  observeLap(car, clean) {
    const old = this.wheelMark, current = car.wheels.map(w => w.tyre.wear), id = car.wheels[0].tyre.compound;
    super.observeLap(car, clean);
    if (old && clean) {
      const rates = current.map((w, i) => Math.max(0, w - old[i]));
      this.wheelRates.set(id, rates);
      const worst = Math.max(...rates);
      if (worst > 0) this.wearPerLap[id] = this.wearPerLap[id] * 0.6 + worst * 0.4;
    }
    this.wheelMark = current;
    this.memo = null;
  }
  planStint(car, n, owed) {
    this.memo = null;
    const id = car.wheels[0].tyre.compound, rate = this.wearRate(id), wear = maxWear(car), age = wear / rate;
    const fuel = Math.max(0, Math.floor(car.fuel / this.fuelPerLap - 0.15)),
      life = Math.max(0, Math.floor((1 - wear) / rate));
    let best = { cost: Infinity, laps: 0 };
    for (let x = 0; x <= Math.min(n, fuel, life); x++) {
      let cost = this.stintCost(id, age, x);
      if (x < n) cost += this.stopLoss + this.planFresh(n - x, Math.max(0, owed - 1)).cost;
      else if (owed > 0) continue;
      if (cost < best.cost) best = { cost, laps: x };
    }
    return best;
  }
  cautionSaving(kind) { return this.laneLoss * (kind === 'sc' ? 0.75 : 0.5); }
  resetMark() { super.resetMark(); this.wheelMark = null; }
  startCompound() {
    const id = super.startCompound();
    this.memo = null;
    const p = this.planFresh(this.cal.laps, this.format.mandatoryStops);
    this.nextTyreLap = p.laps;
    return id;
  }
  finishOnSet(car, laps) {
    const id = car.wheels[0].tyre.compound, compound = COMPOUNDS[id];
    if (!compound || laps < 1 || car.fuel / this.fuelPerLap < laps + 0.2) return false;
    const wear = maxWear(car), rate = this.wearRate(id), fade = this.fade[id] ?? 1, endWear = wear + rate * laps;
    const loss = w => this.lapRef * 0.45 * fade * (0.1 * w + 1.2 * Math.max(0, w - WEAR_CLIFF) ** 2);
    if (endWear > 0.92 || loss(endWear) > 4) return false;
    let stay = 0;
    for (let j = 0; j < laps; j++) stay += this.lapRef * 0.55 * (1 - compound.grip) + loss(wear + (j + 0.5) * rate);
    return stay <= this.stopLoss + this.planFresh(laps, 0).cost;
  }
  decide(car, lapsLeft, aiDriving = true, caution = false) {
    let plan = super.decide(car, lapsLeft, aiDriving, caution);
    const autonomousTyres = plan?.tyres && this.reason.split(' + ').every(r => r === 'TYRES' || r === 'PLAN');
    const rulesMet = this.stops >= this.format.mandatoryStops && (!this.format.mandatorySwap || this.swaps > 0 || this.team.drivers.length < 2);
    if (aiDriving && !this.request && !caution && autonomousTyres && rulesMet && this.finishOnSet(car, Math.max(0, lapsLeft - 1))) {
      plan = this.plan = null;
      this.boxThisLap = false;
      this.reason = 'FINISH ON SET';
    }
    this.memo = null;
    if (plan?.tyres) this.nextTyreLap = car.race.lap;
    else {
      const n = Math.max(0, lapsLeft - 1), owed = Math.max(0, this.format.mandatoryStops - this.stops), p = this.planStint(car, n, owed);
      const remainingSet = Math.max(1, Math.floor((0.86 - maxWear(car)) / this.wearRate(car.wheels[0].tyre.compound)));
      this.nextTyreLap = this.reason === 'FINISH ON SET' ? this.cal.laps + 1 : car.race.lap + Math.max(1, plan && !plan.tyres ? remainingSet : p.laps);
    }
    this.decisions.push({
      lap: car.race.lap, compound: car.wheels[0].tyre.compound, box: Boolean(plan), nextTyreLap: this.nextTyreLap,
      reason: this.reason, lapsLeft, fuel: car.fuel, fuelPerLap: this.fuelPerLap, wear: maxWear(car),
      wearPerLap: this.wearRate(car.wheels[0].tyre.compound), stintLaps: this.stintLaps, stops: this.stops,
      swaps: this.swaps, lapRef: this.lapRef, stopLoss: this.stopLoss, plan: plan ? { ...plan } : null
    });
    if (this.decisions.length > 32) this.decisions.shift();
    return plan;
  }
  stopDone(plan) {
    const prior = this.nextTyreLap;
    super.stopDone(plan);
    this.memo = null;
    this.nextTyreLap = plan.tyres ? null : prior;
  }
}

/** Install VanguardStrategist per entry when VANGUARD v2 is the AI driver for the team. */
export function installVanguardStrategy(race, car) {
  if (!race?.entries || race.session !== 'race') return false;
  const e = race.entryOf?.(car) ?? race.entries.find(e => e.car === car);
  const isVanguard = d => d.kind === 'ai' && (d.id === 'vanguard-v2' || d.id === 'vanguard');
  if (!e || e.strategist instanceof VanguardStrategist || !e.team.drivers.some(isVanguard)) return false;
  if (e.team.drivers.some(d => d.kind === 'ai' && !isVanguard(d))) return false;
  if (e.strategist.stops > 0 || e.strategist.stintLaps > 0) return false;
  e.strategist = new VanguardStrategist(e.strategist, race.track.id, car.classId, race.lane);
  return true;
}
export const installVanguardV2Strategy = installVanguardStrategy;

export class Resources {
  constructor(options) {
    this.options = options;
    this.allowance = 1;
    this.last = null;
    this.rate = null;
    this.compound = null;
  }
  update(car, state, observer, dt) {
    const now = state.time ?? 0, wear = maxWear(car), core = Math.max(...car.wheels.map(w => w.tyre.core - w.tyre.optimum));
    const compound = car.wheels[0].tyre.compound, progress = car.race?.progress ?? 0, length = observer.track.length;
    const reference = state.lapRef ?? car.race?.bestLap, ref = Number.isFinite(reference) && reference > 1 ? reference : car.classId === 'lmdh' ? 53 : 64;
    if (!this.last || compound !== this.compound || wear < this.last.wear - 1e-4) {
      this.last = { time: now, wear, progress };
      this.rate = null;
      this.compound = compound;
    }
    const distance = progress - this.last.progress;
    if (now - this.last.time >= Math.max(15, ref * 0.25) && distance >= length * 0.2) {
      const measured = Math.max(0, wear - this.last.wear) * length / distance;
      this.rate = this.rate === null ? measured : this.rate * 0.55 + measured * 0.45;
      this.last = { time: now, wear, progress };
    }
    const fraction = (Math.max(0, progress) % length) / length, lap = Math.max(1, car.race?.lap ?? 1),
      remaining = Math.max(0.05, (state.totalLaps ?? 20) - lap + 1 - fraction),
      fuelLaps = car.fuel / Math.max(0.1, state.fuelPerLap ?? 8);
    const toTyres = state.pitPlan?.tyres
      ? Math.max(0.05, 1 - fraction)
      : state.nextTyreLap != null
        ? Math.max(0.05, state.nextTyreLap - lap - fraction)
        : Math.min(remaining, Math.max(0.05, fuelLaps));
    const learned = state.wearPerLap?.[compound],
      wearPerLap = this.rate ?? (Number.isFinite(learned) ? learned : 0),
      horizon = Math.min(remaining, toTyres),
      projected = wear + wearPerLap * horizon;
    const fade = ref * 0.45 * (0.1 * projected + 1.2 * Math.max(0, projected - 0.72) ** 2),
      target = observer.list.find(r => r.eligible && r.ds > 0 && r.ds < 90);
    const urgent = remaining < 1.7 || state.pitPlan?.tyres || (target && target.ds < 42 && car.speed > target.v);
    const budget = urgent ? 4 : 3.5;
    const wet = observer.track.water?.live && observer.track.wetness > 0.02;
    const maxSpend = car.classId === 'gt'
      ? (wet || wear >= 0.35 ? 1 : (this.options.gtMaxGripSpend ?? 1))
      : (this.options.maxGripSpend ?? 1);
    const ceiling = Math.min(1 / Math.max(0.6, this.options.margin), Math.max(1, maxSpend));
    let wanted = fade < budget && core < 22 ? ceiling : clamp(1 - (fade - budget) * 0.008, 0.94, 1);
    if (state.session === 'qualifying') wanted = ceiling;
    this.allowance += (wanted - this.allowance) * Math.min(1, dt * 2);
    this.trace = {
      allowance: this.allowance, ceiling, profileMargin: this.options.margin * this.allowance,
      projectedWear: projected, projectedFade: fade, wearPerLap, toTyres, remaining, urgent: Boolean(urgent), hot: core
    };
    return this.allowance;
  }
  energy(car, state, battle, path, controller, observer) {
    if (!car.hybrid) return;
    if (state.session === 'qualifying') { car.intent = null; return; }
    const soc = car.hybrid.energy / 3e6, v = car.speed, finish = (this.trace?.remaining ?? Infinity) < 1.35;
    const rival = observer?.list.find(r => r.id === battle.target && r.eligible),
      fight = rival && battle.side && Math.abs(rival.ds) < 24 && ['ATTACK', 'ALONGSIDE', 'DEFEND', 'TOW'].includes(battle.state);
    const exit = controller.trace?.isExit || controller.trace?.feed > 0 || controller.targetSpeed > v + 1;
    const { deploy, burst } = deployment(soc, v, {
      finish, fight, exit,
      throttle: car.controls.throttle, brake: car.controls.brake,
      source: controller.trace?.source,
      green: !state.formation && !state.caution
    });
    car.intent = { deploy, harvest: soc < 0.35 ? 0.8 : 0.35, ttl: 0.25 };
    if (this.trace) this.trace.energy = { deploy, burst, finish, target: rival?.id ?? null, gap: rival?.ds ?? null, soc };
  }
}
