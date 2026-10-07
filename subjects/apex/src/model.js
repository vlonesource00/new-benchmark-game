import GGV from '../data/ggv.json' with { type: 'json' };
import { tyreGrip } from '../../../game/engine/sim/tyre.js';
import { carSpecFor } from '../../../game/engine/sim/car-specs.js';
import { clamp, table } from './math.js';

// The tyre force shape tanh(s)(1 - 0.16 clamp((s - 1.4)/5, 0, 1)) peaks at s* = 2.40 where it is 0.9528.
export const SLIP_PEAK = 2.4;
export const slipShape = (s) => Math.tanh(s) * (1 - 0.16 * clamp((s - 1.4) / 5, 0, 1));
export const SHAPE_PEAK = slipShape(SLIP_PEAK);

/**
 * g-g-v model of one car class. Tables are identified on the real Vehicle by tools/identify.mjs
 * at the reference state (warm medium tyres at their optimum core temperature, no wear, `fuel` litres).
 * A live state moves the tables through `grip` (a ratio of the game's own tyreGrip to the reference),
 * and the push level through `push` (the slip the tyres are asked to work at, 1 = the force peak).
 */
export class CarModel {
  constructor(classId) {
    this.classId = classId;
    this.g = GGV[classId] ?? GGV.gt;
    this.refGrip = tyreGrip({ core: 90, optimum: 90, pressure: 2.15, wear: 0, gripScale: 1 }, 3300);
    this.grip = 1; this.push = 1; this.brakeMix = 1.6; this.driveMix = 2; this.lateralMix = 1; this.hybrid = 0;
    this.margin = 1;
    const sp = carSpecFor(classId); this.dragK = 0.5 * 1.225 * sp.area * sp.cd / sp.mass;           // clean-air drag deceleration = dragK v²
    // Lateral-jerk limit (m/s³) the car can follow in a direction change: v³ |dk/ds| <= jerk.
    this.jerk = 0;
  }
  /** Peak lateral acceleration at speed v (m/s²). */
  lat(v) { return table(this.g.lateral, v) * this.grip * this.push * this.margin; }
  /** Straight-line braking deceleration at speed v. */
  brake(v) { return table(this.g.brake, v) * (0.2 + 0.8 * this.grip) * (0.5 + 0.5 * this.push) * this.margin; }
  /** Full-throttle acceleration at speed v, with optional hybrid thrust (kW on a car of `mass` kg). */
  drive(v, mass = 1100) {
    const base = table(this.g.drive, v) * (0.25 + 0.75 * this.grip);
    return base + (this.hybrid > 0 ? this.hybrid * 1000 / (Math.max(v, 12) * mass) : 0);
  }
  /** Extra acceleration from a car's slipstream: the game takes up to 42 % off the drag in its wake. */
  towGain(v, wake) { return 0.42 * wake * this.dragK * v * v; }
  /** Share of the lateral capacity that comes from downforce at speed v (what dirty air takes 16 % of). */
  dfShare(v) { return clamp(1 - table(this.g.lateral, 20) / table(this.g.lateral, Math.max(20, v)), 0, 0.7); }
  /** Speed factor in another car's wake: the game removes up to 16 % of the downforce. */
  wakeSpeed(v, wake) { return wake > 0 ? Math.sqrt(1 - 0.16 * Math.min(0.95, wake) * this.dfShare(v)) : 1; }
  /** Steady-state steering (normalised) that gives lateral acceleration ay at speed v. */
  steerFor(ay, v) { return this.mapFor(this.g.steer, ay, v); }
  /** Steady-state body sideslip (rad, opposite sign to ay in the game's convention) at ay and v. */
  betaFor(ay, v) { return this.mapFor(this.g.beta, ay, v); }
  mapFor(maps, ay, v) {
    const a = Math.abs(ay) / Math.max(0.3, this.grip * this.push);
    let i = 1; while (i < maps.length - 1 && maps[i][0] < v) i++;
    const [v0, m0] = maps[i - 1], [v1, m1] = maps[i], t = clamp((v - v0) / (v1 - v0), 0, 1);
    const at = (m) => { const k = a - 1; if (k <= 0) return m[0] * Math.max(0, a); const j = Math.min(m.length - 2, Math.floor(k)); return m[j] + (m[j + 1] - m[j]) * Math.min(1.5, k - j); };
    return Math.sign(ay) * (at(m0) * (1 - t) + at(m1) * t);
  }
}

/**
 * Grip ratio of a live car versus the identification reference, from the game's own tyre formula applied to each
 * wheel's live state. Returns the worst axle's grip and how much weaker the rear is than the front.
 */
export function liveGrip(car) {
  const axle = [2, 2];
  car.wheels.forEach((w, n) => {
    const t = w.tyre, load = w.load > 100 ? w.load : 3300, a = n < 2 ? 0 : 1;
    const g = tyreGrip(t, load) / tyreGrip({ ...t, core: t.optimum ?? 90, pressure: 2.15, wear: 0, gripScale: 1 }, load);
    if (g < axle[a]) axle[a] = g;
  });
  return { grip: Math.min(axle[0], axle[1]), front: axle[0], rear: axle[1], imbalance: axle[0] - axle[1] };
}
