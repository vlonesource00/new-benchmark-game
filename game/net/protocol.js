// Pose wire format shared by the local sim worker and (M4) the LAN host.
// One Float32Array per frame: [time, phase, countdown, n, ...n × CAR_STRIDE].
export const PHASES = ['grid', 'countdown', 'racing', 'finished'];
export const ZONES = ['asphalt', 'kerb', 'gravel', 'grass', 'pit'];
export const CAR_FIELDS = ['x', 'y', 'z', 'yaw', 'roll', 'pitch', 'heave', 'steering', 'speed', 'rpm', 'gear', 'vx', 'vz', 'u', 'v', 'impact', 'throttle', 'brake', 'zone'];
export const WHEEL_FIELDS = ['omega', 'steer', 'compression', 'load', 'brakeTemp', 'alpha', 'kappa', 'slipPower'];
const ANGLES = new Set(['yaw']);
const DISCRETE = new Set(['gear', 'zone']);
const TYRE = new Set(['alpha', 'kappa', 'slipPower']);
export const HEADER = 4;
export const CAR_STRIDE = CAR_FIELDS.length + 4 * WHEEL_FIELDS.length;

export function packPoses(race) {
  const cars = race.cars, out = new Float32Array(HEADER + cars.length * CAR_STRIDE);
  out[0] = race.time; out[1] = PHASES.indexOf(race.phase); out[2] = race.countdown; out[3] = cars.length;
  let o = HEADER;
  for (const c of cars) {
    for (const k of CAR_FIELDS) {
      out[o++] = k === 'zone' ? Math.max(0, ZONES.indexOf(c.zone)) : k === 'throttle' || k === 'brake' ? c.controls[k] ?? 0 : c[k] ?? 0;
    }
    for (const w of c.wheels) for (const k of WHEEL_FIELDS) out[o++] = TYRE.has(k) ? w.tyre[k] ?? 0 : w[k] ?? 0;
  }
  return out;
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Writes frame a→b at `u` into the proxy Vehicle objects the renderers read. */
export function applyPoses(cars, a, b, u) {
  const n = Math.min(cars.length, b[3]);
  for (let i = 0; i < n; i += 1) {
    const car = cars[i]; let o = HEADER + i * CAR_STRIDE;
    for (const k of CAR_FIELDS) {
      const va = a[o], vb = b[o]; o += 1;
      const v = DISCRETE.has(k) ? vb : ANGLES.has(k) ? va + wrapAngle(vb - va) * u : va + (vb - va) * u;
      if (k === 'zone') car.zone = ZONES[v] ?? 'asphalt';
      else if (k === 'throttle' || k === 'brake') car.controls[k] = v;
      else car[k] = v;
    }
    for (const w of car.wheels) for (const k of WHEEL_FIELDS) {
      const v = a[o] + (b[o] - a[o]) * u; o += 1;
      if (TYRE.has(k)) w.tyre[k] = v; else w[k] = v;
    }
  }
}

/**
 * Buffers pose frames and replays them a little behind the newest one, so the
 * render stays smooth when frames arrive unevenly (worker or network).
 */
export class PoseBuffer {
  constructor(buffer = 1 / 20) { this.buffer = buffer; this.reset(); }
  reset() { this.frames = []; this.clock = null; }
  push(buf) {
    const last = this.frames.at(-1);
    if (last && buf[0] < last[0]) this.frames = []; // race restarted
    this.frames.push(buf);
    if (this.frames.length > 40) this.frames.shift();
  }
  get latest() { return this.frames.at(-1) ?? null; }
  /** Advances the replay clock by `delta` sim-seconds and writes cars. */
  apply(cars, delta) {
    const f = this.frames; if (!f.length) return null;
    const newest = f.at(-1)[0], target = newest - this.buffer;
    if (this.clock === null || Math.abs(target - this.clock) > 0.5) this.clock = target;
    else this.clock += delta + (target - this.clock) * 0.1;
    this.clock = Math.min(this.clock, newest);
    let i = f.length - 1;
    while (i > 0 && f[i - 1][0] >= this.clock) i -= 1;
    const b = f[i], a = f[Math.max(0, i - 1)];
    const u = b[0] > a[0] ? Math.min(1, Math.max(0, (this.clock - a[0]) / (b[0] - a[0]))) : 1;
    applyPoses(cars, a, b, u);
    return b;
  }
}
