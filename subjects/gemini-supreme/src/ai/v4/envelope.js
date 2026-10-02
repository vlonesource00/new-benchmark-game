/**
 * Gemini Supreme v4 — g-g-v performance envelope.
 *
 * A point-mass friction-ellipse model of the car, built from the published
 * class spec (mass, aero, gearing, torque curve, tyre law shape) and scaled by
 * a small set of identified coefficients (see DESIGN.md). It is a model of the
 * *limits*, not of the transient plant: the tracker closes the loop.
 */

const G = 9.81;
const RHO = 1.225;

export const DEFAULT_ENVELOPE = Object.freeze({
  muLat: 1.34,     // identified lateral friction scale (peak-ish, incl. tanh shape)
  muBrake: 1.28,   // identified straight-line braking scale (ABS-limited)
  muDrive: 1.20,   // rear traction scale
  engineEff: 0.93, // shift cuts / TC losses on the engine force
  fuel: 35,
  wing: 6,
  trail: 2.0,      // brake/lateral combination exponent (1 = circle, 2 = 1-r^2)
  trailFast: 3.5,  // ... blended in from trailFastV (55 m/s) to +10 m/s
  trailFastV: 55,
  aeroLat: 0.4     // fraction of modelled downforce that shows up as lateral grip (identified)
});

/**
 * Temperature/pressure/wear part of the tyre law, normalised to its optimum.
 * Game tyres carry a compound (`optimum` window, `gripScale`) and fade gently
 * until a cliff past 72 % wear; host tyres peak at 85 C and lose 35 % linearly.
 */
export function tyreThermalFactor(t) {
  const temp = Math.min(1, Math.max(0.65, 1 - ((t.core - (t.optimum ?? 85)) / 105) ** 2));
  const pressure = Math.min(1, Math.max(0.8, 1 - Math.abs(t.pressure - 2.15) * 0.13));
  const wear = t.optimum === undefined ? 1 - t.wear * 0.35 : 1 - 0.10 * t.wear - 1.2 * Math.max(0, t.wear - 0.72) ** 2;
  return temp * pressure * wear * (t.gripScale ?? 1);
}

export class Envelope {
  constructor(spec, params = {}) {
    this.spec = spec;
    this.p = { ...DEFAULT_ENVELOPE, ...params };
    const p = this.p;
    this.mass = spec.mass + p.fuel * 0.75;
    this.kDown = 0.5 * RHO * spec.area * (spec.cl + (p.wing - 6) * 0.11);
    this.kDrag = 0.5 * RHO * spec.area * (spec.cd + (p.wing - 6) * 0.013);
    this.ratios = spec.gears.slice(1).map((g) => g * spec.finalDrive);
    this.grip = 1; // live scale from tyre state
    this.build();
  }

  loadSens(v) {
    const perWheel = (this.mass * G + this.kDown * v * v) / 4;
    return Math.min(1.18, Math.max(0.68, 1 - 0.13 * Math.log(Math.max(0.1, perWheel / 3300))));
  }

  normalAccel(v) { return G + this.kDown * v * v / this.mass; }
  dragAccel(v) { return this.kDrag * v * v / this.mass; }

  /** Engine force (N) at full throttle in the gear the host gearbox would hold. */
  engineForce(v) {
    const spec = this.spec;
    let ratio = this.ratios[this.ratios.length - 1];
    for (const r of this.ratios) {
      const rpm = Math.abs(v) / spec.radius * r * 9.5493;
      if (rpm < 7450) { ratio = r; break; }
    }
    const rpm = Math.min(8300, Math.max(1100, Math.abs(v) / spec.radius * ratio * 9.5493));
    const curve = Math.min(1, Math.max(0.45, 1 - ((rpm - 5500) / 6700) ** 2));
    return spec.maxTorque * curve * ratio * 0.91 / spec.radius;
  }

  latRaw(v) { return this.p.muLat * this.loadSens(v) * (G + this.p.aeroLat * this.kDown * v * v / this.mass); }
  brakeRaw(v) { return this.p.muBrake * this.loadSens(v) * this.normalAccel(v); }
  driveRaw(v) {
    const rear = (this.mass * G * (1 - this.spec.frontWeight) + this.kDown * v * v * 0.57) / this.mass;
    const traction = this.p.muDrive * this.loadSens(v) * rear;
    return Math.min(traction, this.engineForce(v) * this.p.engineEff / this.mass);
  }

  /** Tabulate on a 0.5 m/s grid; grip scale is applied at lookup. */
  build() {
    const n = 200;
    this.tLat = new Float64Array(n); this.tBrake = new Float64Array(n);
    this.tDrive = new Float64Array(n); this.tDrag = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = i * 0.5;
      this.tLat[i] = this.latRaw(v); this.tBrake[i] = this.brakeRaw(v);
      this.tDrive[i] = this.driveRaw(v); this.tDrag[i] = this.dragAccel(v);
    }
    let lo = 20, hi = 99;
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (this.driveRaw(m) > this.dragAccel(m) + 0.02) lo = m; else hi = m; }
    this.vTop = lo;
  }

  look(tab, v) {
    const f = Math.max(0, v) * 2;
    const i = Math.min(tab.length - 2, f | 0), t = Math.min(1, f - i);
    return tab[i] + (tab[i + 1] - tab[i]) * t;
  }

  lat(v, grip = this.grip) { return this.look(this.tLat, v) * grip; }
  brake(v, grip = this.grip) { return this.look(this.tBrake, v) * grip; }
  drive(v, grip = this.grip) { return Math.min(this.look(this.tDrive, v), this.look(this.tDrive, v) * (0.5 + 0.5 * grip)); }
  drag(v) { return this.look(this.tDrag, v); }

  /** Max steady speed on curvature k (fixed point of v^2 k = aLat(v)). */
  cornerSpeed(k, grip = this.grip) {
    k = Math.abs(k);
    if (k < 1e-5) return this.vTop;
    let v = Math.sqrt(this.lat(40, grip) / k);
    for (let i = 0; i < 5; i++) v = Math.sqrt(this.lat(Math.min(v, 99), grip) / k);
    return Math.min(this.vTop, v);
  }
}
