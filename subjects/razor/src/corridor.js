import { clamp, angle } from '../../apex/src/math.js';

const smooth = t => { t = clamp(t, 0, 1); return t * t * t * (10 + t * (-15 + 6 * t)); };

// A short-lived corridor, fitted to measured position, heading and yaw rate.
// The buffers are retained across decisions; the active buffer is never edited.
export class Corridors {
  constructor(driver) {
    this.driver = driver;
    this.pool = Array.from({ length: 6 }, () => driver.line.blankLane());
    for (const p of this.pool) p.offset = new Float64Array(driver.line.N);
    this.shift = new Float64Array(220);
    this.rawGoal = new Float64Array(220);
    this.smoothGoal = new Float64Array(220);
    const base = driver.line;
    this.normalH = new Float64Array(base.N);
    for (let i = 0; i < base.N; i++) {
      const a = base.idx(i - 3), b = base.idx(i + 3);
      this.normalH[i] = Math.atan2(base.px[b] - base.px[a], base.pz[b] - base.pz[a]);
    }
  }
  build(car, c, goal, entry, hold, active = null) {
    const d = this.driver, base = d.line, v = Math.max(8, car.speed);
    const lane = this.pool.find(p => p !== active && !p.busy);
    if (!lane) throw new Error('RAZOR corridor pool exhausted');
    lane.busy = true;
    const q = base.closest(car.x, car.z, c.i), h = base.heading(q.i, q.f);
    const beta = Math.atan2(car.v, Math.max(2, car.u));
    const slope = clamp(Math.tan(angle(car.yaw + beta - h)), -0.28, 0.28);
    const curve = clamp((car.ay ?? 0) / (v * v) - base.sample(base.ks, q.i, q.f), -0.002, 0.002);
    const d0 = q.e, total = Math.min(630, Math.max(180, entry + hold + Math.max(50, v * 1.5)));
    const tailStart = Math.max(entry, Math.min(entry + hold, total - Math.max(50, v * 1.5)));
    const n = Math.min(this.shift.length - 1, Math.ceil(total / base.ds));
    for (let j = 0; j <= n; j++) {
      const i = base.idx(q.i + j); this.rawGoal[j] = goal(base.st[i], i);
    }
    // A polygonal road join can briefly remove the space on one side. Pointwise
    // clipping would make a sharp notch and propagate heavy braking upstream.
    // Anticipate that narrowing with smooth tapers, always toward the proven
    // base line and never beyond the available offset at a station.
    const blend = Math.max(40, v * 1.25), radius = Math.ceil(blend / base.ds);
    for (let j = 0; j <= n; j++) {
      const magnitude = Math.abs(this.rawGoal[j]); let safe = magnitude;
      for (let k = Math.max(0, j - radius); k <= Math.min(n, j + radius); k++) {
        const other = Math.abs(this.rawGoal[k]);
        if (other < magnitude) safe = Math.min(safe, other + (magnitude - other) * smooth(Math.abs(j - k) * base.ds / blend));
      }
      this.smoothGoal[j] = Math.sign(this.rawGoal[j]) * safe;
    }
    // C2 initial conditions. The correction decays to zero with zero first
    // and second derivatives; the destination can follow a rival's road line.
    const at = (x, j) => {
      const i = base.idx(q.i + j);
      const target = this.smoothGoal[j];
      const t = clamp(x / entry, 0, 1), S = smooth(t);
      const tail = 1 - smooth((x - tailStart) / Math.max(1, total - tailStart));
      // Quintic Hermite basis: position, slope and curvature each settle
      // independently. Multiplying the whole incoming quadratic by (1-S)
      // lets its slope/curvature terms bulge far beyond the requested lane.
      const h1 = t - 6 * t ** 3 + 8 * t ** 4 - 3 * t ** 5;
      const h2 = 0.5 * t * t * (1 - t) ** 3;
      const initial = d0 * (1 - S) + slope * entry * h1 + curve * entry * entry * h2;
      return (initial + target * S) * tail;
    };
    for (let j = 0; j <= n; j++) this.shift[j] = at((j - q.f) * base.ds, j);
    base.laneWindow(this.shift, q.i, n, lane);
    for (let j = -14; j <= n + 16; j++) lane.offset[base.idx(q.i + j)] = 0;
    for (let j = 0; j <= n; j++) {
      const i = base.idx(q.i + j), h = this.normalH[i], offset = this.shift[j];
      lane.offset[i] = offset;
      lane.px[i] = base.px[i] + Math.cos(h) * offset;
      lane.pz[i] = base.pz[i] - Math.sin(h) * offset;
    }
    // Keep the incoming tangent too, rather than a constant offset behind the
    // car. This prevents a new corridor from introducing a heading kink.
    for (let j = -9; j < 0; j++) {
      const i = base.idx(q.i + j), x = (j - q.f) * base.ds;
      const offset = clamp(d0 + slope * x + 0.5 * curve * x * x, d0 - 3, d0 + 3);
      lane.px[i] = base.px[i] + Math.cos(this.normalH[i]) * offset;
      lane.pz[i] = base.pz[i] - Math.sin(this.normalH[i]) * offset;
      lane.lat[i] = base.lat[i] + offset;
      lane.offset[i] = offset;
    }
    lane.geometryRange(q.i - 10, n + 12);
    const end = base.idx(q.i + n);
    lane.cap = base.cap;
    lane.speedsWindow(d.model, q.i, n, v, base.v[end], {
      mass: car.spec.mass + car.fuel * 0.75, jerk: d.options.jerk,
      vbrkEnd: base.vbrk[end], brakeExp: d.options.circleExp ?? 2,
      driveExp: d.options.circleExp ?? 2
    });
    return { path: lane, i: q.i, f: q.f, entry, total, n };
  }
  release() { for (const p of this.pool) p.busy = false; }
}
