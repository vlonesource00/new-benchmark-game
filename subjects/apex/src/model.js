import GGV from '../data/ggv.json' with { type: 'json' };
import { tyreGrip } from '../../../game/engine/sim/tyre.js';
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

/** Grip ratio of a live car versus the identification reference (game tyre formula, per wheel, worst axle). */
export function liveGrip(car) {
  let worst = 2;
  for (const w of car.wheels) {
    const t = w.tyre, load = w.load > 100 ? w.load : 3300;
    const g = tyreGrip(t, load) / tyreGrip({ ...t, core: t.optimum ?? 90, pressure: 2.15, wear: 0, gripScale: 1 }, load);
    if (g < worst) worst = g;
  }
  return worst;
}
