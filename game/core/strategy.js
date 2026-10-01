import { COMPOUNDS, TANK_LITRES, WEAR_CLIFF } from './rules.js';

/**
 * One strategist per team. It measures real fuel burn and tyre wear per lap
 * from the car, then decides at each lap's decision point whether to box and
 * what the stop contains. Human teams get the same advice and can override it
 * (box request, compound, swap, fuel).
 */
export class TeamStrategist {
  constructor(team, cal, format) {
    this.team = team; this.cal = cal; this.format = format;
    this.fuelPerLap = cal.lapFuel;
    this.wearPerLap = { ...Object.fromEntries(Object.values(COMPOUNDS).map((c) => [c.id, WEAR_CLIFF * c.wear / cal.tyreLaps])) };
    this.stops = 0; this.swaps = 0; this.boxThisLap = false; this.reason = '';
    this.request = null;           // human override: { compound, swap, fuel }
    this.lapMark = null;
    this.stintLaps = 0;
  }
  compoundLife(id) { return (WEAR_CLIFF + 0.06) / this.wearPerLap[id]; }
  /** Called when the car completes a lap (not an in/out lap). */
  observeLap(car, clean) {
    const now = { fuel: car.fuel, wear: maxWear(car) };
    if (this.lapMark && clean) {
      const fuel = this.lapMark.fuel - now.fuel, wear = now.wear - this.lapMark.wear;
      if (fuel > 0) this.fuelPerLap = this.fuelPerLap * 0.5 + fuel * 0.5;
      const id = car.wheels[0].tyre.compound;
      if (wear > 0) this.wearPerLap[id] = this.wearPerLap[id] * 0.5 + wear * 0.5;
    }
    this.lapMark = now; this.stintLaps += 1;
  }
  resetMark() { this.lapMark = null; this.stintLaps = 0; }
  /**
   * Decision for the lap about to reach the pit approach. `lapsLeft` counts
   * laps still to complete including the current one.
   */
  decide(car, lapsLeft) {
    const fuelLaps = car.fuel / this.fuelPerLap, wear = maxWear(car);
    const id = car.wheels[0].tyre.compound;
    const reasons = [];
    if (lapsLeft <= 1 && !this.request) { this.boxThisLap = false; this.reason = 'FINAL LAP'; return this.plan = null; }
    // Box now when the car cannot complete the next full lap with margin.
    if (fuelLaps < 1.15 && fuelLaps < lapsLeft - 0.9) reasons.push('FUEL');
    if (wear + this.wearPerLap[id] * 1.05 > WEAR_CLIFF + 0.05 && lapsLeft > 1) reasons.push('TYRES');
    const owed = Math.max(0, this.format.mandatoryStops - this.stops);
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
    let tyres = wear + this.wearPerLap[id] * stintLaps > WEAR_CLIFF + 0.04 || wear > 0.4;
    let compound = id;
    if (tyres) {
      compound = ['soft', 'medium', 'hard'].find((c) => this.compoundLife(c) >= stintLaps) ?? 'hard';
    }
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
  // Human-led teams hand the car to the AI for the middle stint of long races.
  stintBalanced() { return this.stintLaps >= Math.ceil(this.cal.laps / 2); }
  stopDone(plan) { this.stops += 1; if (plan.swap) this.swaps += 1; this.request = null; this.boxThisLap = false; this.resetMark(); }
}

export function maxWear(car) { return Math.max(...car.wheels.map((w) => w.tyre.wear)); }
