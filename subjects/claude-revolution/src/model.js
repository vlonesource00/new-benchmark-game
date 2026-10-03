import GGV from '../data/ggv.json' with { type: 'json' };

/** Piecewise-linear lookup in a [[v, a], ...] table, clamped at both ends. */
export function table(t, v) {
  if (v <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (v <= t[i][0]) {
    const [v0, a0] = t[i - 1], [v1, a1] = t[i];
    return a0 + (a1 - a0) * (v - v0) / (v1 - v0);
  }
  return t.at(-1)[1];
}

/**
 * g-g-v model of one car class, identified on the real game Vehicle
 * (tools/identify.mjs, warm soft tyres, no wear, 40 L). `grip` scales the
 * tyre-limited parts for live compound, wear, temperature and surface;
 * `learnt` drive capacity replaces the table once measured (it carries the
 * GTP hybrid thrust, which the identification rig does not have).
 */
export class CarModel {
  constructor(classId) {
    this.g = GGV[classId] ?? GGV.gt;
    this.grip = 1; this.latScale = 1;
    // Aerodynamic drag deceleration per v² (½ρ·A·cd / m from the class spec, ~half tank).
    this.dragK = classId === 'gt' ? 5.6e-4 : 7.6e-4;
    this.learnt = new Float64Array(20).fill(NaN);
  }
  lat(v) { return table(this.g.lateral, v) * this.grip * this.latScale; }
  brake(v) { return table(this.g.brake, v) * (0.15 + 0.85 * this.grip); }
  drive(v) {
    const bin = Math.min(19, Math.max(0, Math.round(v / 5)));
    const base = v > this.g.drive.at(-1)[0] ? Math.max(0, this.g.drive.at(-1)[1] * (1 - (v - this.g.drive.at(-1)[0]) / 10)) : table(this.g.drive, v) * 0.94;
    const learnt = this.learnt[bin];
    return Number.isFinite(learnt) ? Math.max(base * 0.7, learnt) : base;
  }
  /**
   * Grip left in a car's wake: the game takes up to 16 % of the downforce away,
   * and downforce is the part of the identified lateral capacity that grows
   * with speed above the low-speed (mechanical) value.
   */
  wakeFactor(v, wake) {
    if (!(wake > 0)) return 1;
    const t = this.g.lateral, share = Math.max(0, 1 - t[0][1] * 0.95 / table(t, v));
    return 1 - 0.16 * wake * share;
  }
  /** Full-throttle straight-line sample (actual ax at speed v). */
  observeDrive(v, ax) {
    const bin = Math.min(19, Math.max(0, Math.round(v / 5)));
    const old = this.learnt[bin];
    this.learnt[bin] = Number.isFinite(old) ? old * 0.97 + ax * 0.03 : ax;
  }
  /** Steady-state steer (normalised) giving lateral acceleration `ay` at speed `v`. */
  steerFor(ay, v) {
    const maps = this.g.steer, a = Math.abs(ay) / Math.max(0.3, this.grip);
    let i = 1; while (i < maps.length - 1 && maps[i][0] < v) i++;
    const [v0, m0] = maps[i - 1], [v1, m1] = maps[i], t = Math.max(0, Math.min(1, (v - v0) / (v1 - v0)));
    const at = (m) => { const k = a - 1; if (k <= 0) return m[0] * Math.max(0, a); const j = Math.min(m.length - 2, Math.floor(k)); return m[j] + (m[j + 1] - m[j]) * Math.min(1.5, k - j); };
    return Math.sign(ay) * (at(m0) * (1 - t) + at(m1) * t);
  }
}
