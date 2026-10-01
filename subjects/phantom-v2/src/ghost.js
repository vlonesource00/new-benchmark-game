// Ghost tape: the only long-range knowledge PHANTOM carries.
//
// A ghost is a recorded, physically executed lap of the exact plant, sampled
// every metre of track distance: arrival time, speed, lateral position,
// heading and the controls that produced it. It is not a reference path to
// track. The planner uses it as a value function: "how long did a car that
// really drove this take from here to the line?", plus an envelope that says
// which terminal speeds are still brakeable for the corners beyond the
// planning horizon.

import { makeShadow } from './plant.js';

const FLAT = { s: 0, lateral: 0, nx: 1, nz: 0, tx: 0, tz: 1, curvature: 0, index: 0, zone: 'asphalt', rubber: 0, grip: 1, bump: 0, resistance: 0.013 };

const wrap = (x, n) => ((x % n) + n) % n;

export class Ghost {
  constructor({ length, origin = 0, lapTime, t, v, q, psi = null, steer = null, pedal = null, delta = null }) {
    this.length = length;
    this.origin = origin; // track s of the timing line; ghost stations are lap distance u
    this.n = t.length;
    this.ds = length / this.n;
    this.lapTime = lapTime;
    this.t = Float64Array.from(t);
    this.v = Float32Array.from(v);
    this.q = Float32Array.from(q);
    this.psi = Float32Array.from(psi ?? new Array(this.n).fill(0));
    this.steer = Float32Array.from(steer ?? new Array(this.n).fill(0));
    this.pedal = Float32Array.from(pedal ?? new Array(this.n).fill(0));
    this.delta = Float32Array.from(delta ?? new Array(this.n).fill(0));
    this.brakeDecel = null;
    this.hasControls = this.steer.some((x) => x !== 0);
  }

  lapDistance(s) { return wrap(s - this.origin, this.length); }

  // Linear interpolation of an s-indexed array.
  sample(arr, s) {
    const x = wrap(s, this.length) / this.ds;
    const i = Math.floor(x) % this.n, f = x - Math.floor(x);
    return arr[i] + (arr[(i + 1) % this.n] - arr[i]) * f;
  }

  // Ghost clock over unwrapped distance: lap multiples are added exactly.
  clock(sUnwrapped) {
    const laps = Math.floor(sUnwrapped / this.length);
    const x = (sUnwrapped - laps * this.length) / this.ds;
    const i = Math.floor(x), f = x - i;
    const a = this.t[i % this.n];
    const b = i + 1 >= this.n ? this.lapTime : this.t[i + 1];
    return laps * this.lapTime + a + (b - a) * f;
  }

  speed(s) { return this.sample(this.v, s); }
  lateral(s) { return this.sample(this.q, s); }
  heading(s) { return this.sample(this.psi, s); }

  // Measures the plant's straight-line maximum deceleration as a function of
  // speed. The envelope below is built from what the car can really do.
  calibrate(track, car) {
    // Straight-line stop on an endless flat asphalt strip (no rubber, dry).
    const flat = { barrierOffset: 1e9, deposit() {}, surface: () => FLAT, at: () => ({ x: 0, z: 0, heading: 0, tx: 0, tz: 1, s: 0 }) };
    const shadow = makeShadow(car);
    shadow.place(flat, 0, 0, 88);
    for (const w of shadow.wheels) { w.tyre.core = 85; w.tyre.surface = 90; }
    const table = new Float32Array(100);
    let last = shadow.speed, filled = 0;
    shadow.controls.throttle = 0; shadow.controls.brake = 1; shadow.controls.steer = 0;
    for (let k = 0; k < 120 * 12 && shadow.speed > 6; k++) {
      shadow.step(1 / 120, flat, 0);
      if (k % 6 === 5) {
        const d = (last - shadow.speed) * 20;
        const b = Math.round(shadow.speed);
        if (b >= 0 && b < 100 && d > 0) { table[b] = Math.max(table[b], d); filled++; }
        last = shadow.speed;
      }
    }
    // Fill gaps and extrapolate to the ends.
    let prev = 0;
    for (let i = 0; i < 100; i++) if (table[i] > 0) { prev = table[i]; break; }
    for (let i = 0; i < 100; i++) { if (table[i] > 0) prev = table[i]; else table[i] = prev; }
    this.brakeDecel = table;
    return table;
  }

  decel(v) {
    if (!this.brakeDecel) return 14;
    return this.brakeDecel[Math.max(0, Math.min(99, Math.round(v)))];
  }

  // Apex stations: local speed minima of the ghost. Only these are hard
  // speed limits; everywhere else a faster car is a better car.
  findApexes() {
    const n = this.n, w = Math.round(25 / this.ds), out = [];
    for (let i = 0; i < n; i++) {
      let min = true;
      for (let k = -w; k <= w && min; k++) if (k && this.v[(i + k + n) % n] < this.v[i]) min = false;
      if (min && this.v[i] < 75 && (out.length === 0 || i - out.at(-1) > w)) out.push(i);
    }
    this.apexes = out;
    return out;
  }

  // Mid-corner holds: where the ghost has shed > 8 m/s over the last 60 m and
  // is now coasting, it was lateral-limited, not braking for a later apex.
  // Such plateaus are not local minima, so without a hold the envelope lets
  // a rollout arrive far too fast. One hold per plateau, at its slowest point.
  findHolds() {
    const n = this.n, v = this.v, h = Math.round(5 / this.ds), back = Math.round(60 / this.ds), out = [];
    let run = -1;
    for (let i = 0; i <= n; i++) {
      const j = i % n, a = (v[(j + h) % n] ** 2 - v[(j - h + n) % n] ** 2) / (4 * h * this.ds);
      const on = i < n && a > -4 && a < 2 && v[(j - back + n) % n] - v[j] > 8 && v[j] < 70;
      if (on && (run < 0 || v[j] < v[run])) run = j;
      else if (!on && run >= 0) { out.push(run); run = -1; }
    }
    return out;
  }

  // Brakeable terminal speed at every station, for apex speeds v + delta,
  // with a fixed fraction of straight-line braking reserved for steering.
  buildEnvelope(margin = 0.86, hold = 1.5) {
    if (!this.apexes) this.findApexes();
    const n = this.n, cap = new Float32Array(n).fill(Infinity);
    for (const i of this.apexes) cap[i] = this.v[i] + this.delta[i];
    for (const i of this.findHolds()) cap[i] = Math.min(cap[i], this.v[i] + hold);
    for (let pass = 0; pass < 2; pass++) {
      for (let j = n - 1; j >= 0; j--) {
        const next = cap[(j + 1) % n];
        if (!Number.isFinite(next)) continue;
        const a = this.decel(next) * margin;
        cap[j] = Math.min(cap[j], Math.sqrt(next * next + 2 * a * this.ds));
      }
    }
    this.cap = cap;
    // Time from each station to the next apex, capped: how long a speed
    // excess or deficit at a horizon's end keeps paying out.
    const toApex = new Float32Array(n);
    const apexSet = new Set(this.apexes);
    let nextT = null;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = n - 1; j >= 0; j--) {
        if (apexSet.has(j)) nextT = this.t[j] + (pass === 0 ? this.lapTime : 0);
        if (nextT !== null) toApex[j] = Math.min(2.5, Math.max(0, nextT - this.t[j]));
      }
    }
    this.toApex = toApex;
    return cap;
  }

  capAt(s) { return this.sample(this.cap, s); }
  apexLead(s) { return this.sample(this.toApex, s); }

  toJSON(extra = {}) {
    const r = (arr, d) => Array.from(arr, (x) => Number(x.toFixed(d)));
    return {
      length: this.length, origin: this.origin, lapTime: this.lapTime, ...extra,
      t: r(this.t, 4), v: r(this.v, 3), q: r(this.q, 3), psi: r(this.psi, 4),
      steer: r(this.steer, 4), pedal: r(this.pedal, 3), delta: r(this.delta, 2)
    };
  }
}

// Seed ghost for the very first practice lap, before anything has been
// driven. Deliberately crude and slow: it only has to keep the first forge
// lap on the road. Every later ghost comes from the plant itself.
export function seedGhost(track, { lateralAccel = 9, bins = null } = {}) {
  const n = bins ?? Math.floor(track.length);
  const ds = track.length / n;
  const k = new Float32Array(n);
  const origin = track.finishS;
  for (let i = 0; i < n; i++) k[i] = Math.abs(track.at(origin + i * ds).curvature);
  // Wide-line radius: average curvature over a window, then relax it as if
  // the car used most of the road.
  const w = Math.round(18 / ds), v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = -w; j <= w; j++) sum += k[(i + j + n) % n];
    const kappa = sum / (2 * w + 1) * 0.7;
    v[i] = Math.min(80, Math.sqrt(lateralAccel / Math.max(kappa, 1e-4)));
  }
  // Physically consistent profile: forward acceleration and backward braking.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < 2 * n; i++) { const a = i % n, b = (i - 1) % n; v[a] = Math.min(v[a], Math.sqrt(v[b] ** 2 + 2 * 6 * ds)); }
    for (let i = 2 * n - 2; i >= 0; i--) { const a = i % n, b = (i + 1) % n; v[a] = Math.min(v[a], Math.sqrt(v[b] ** 2 + 2 * 9 * ds)); }
  }
  const t = new Float64Array(n);
  for (let i = 1; i < n; i++) t[i] = t[i - 1] + ds * 2 / (v[i] + v[i - 1]);
  const lapTime = t[n - 1] + ds * 2 / (v[0] + v[n - 1]);
  const psi = Array.from({ length: n }, (_, i) => track.at(origin + i * ds).heading);
  return new Ghost({ length: track.length, origin, lapTime, t, v, q: new Float32Array(n), psi });
}

// Records a driven lap into a ghost, station by station.
export class GhostRecorder {
  constructor(length, bins, origin) {
    this.length = length; this.origin = origin; this.n = bins; this.ds = length / bins;
    this.reset();
  }
  reset() {
    this.t = new Float64Array(this.n).fill(NaN);
    this.v = new Float32Array(this.n); this.q = new Float32Array(this.n); this.psi = new Float32Array(this.n);
    this.steer = new Float32Array(this.n); this.pedal = new Float32Array(this.n);
    this.startTime = null; this.valid = true; this.lastBin = -1;
  }
  begin(time) { this.reset(); this.startTime = time; }
  push(time, u, car) {
    if (this.startTime === null) return;
    const bin = Math.floor(wrap(u, this.length) / this.ds) % this.n;
    if (!Number.isNaN(this.t[bin])) return;
    this.t[bin] = time - this.startTime; this.v[bin] = car.speed; this.q[bin] = car.lateral;
    this.psi[bin] = car.yaw; this.steer[bin] = car.controls.steer;
    this.pedal[bin] = (car.controls.throttle || 0) - (car.controls.brake || 0);
  }
  finish(lapTime, delta) {
    // Fill missed bins by interpolation; the first bin is the line crossing.
    const n = this.n, t = this.t;
    if (Number.isNaN(t[0])) t[0] = 0;
    for (let i = 1; i < n; i++) if (Number.isNaN(t[i])) {
      let j = i; while (j < n && Number.isNaN(t[j])) j++;
      const a = i - 1, b = j < n ? j : null;
      for (let k = i; k < j; k++) {
        const f = b === null ? 1 : (k - a) / (b - a);
        t[k] = b === null ? t[a] + (k - a) * this.ds / Math.max(5, this.v[a]) : t[a] + (t[b] - t[a]) * f;
        const src = b === null ? a : (f < 0.5 ? a : b);
        this.v[k] = this.v[src]; this.q[k] = this.q[src]; this.psi[k] = this.psi[src]; this.steer[k] = this.steer[src]; this.pedal[k] = this.pedal[src];
      }
      i = j - 1;
    }
    return new Ghost({ length: this.length, origin: this.origin, lapTime, t, v: this.v, q: this.q, psi: this.psi, steer: this.steer, pedal: this.pedal, delta });
  }
}
