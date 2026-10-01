import * as THREE from 'three';

// Instant replay. The recorder keeps the last SECONDS of every car's visible
// state at RATE Hz in flat ring buffers; playback writes interpolated frames
// back into the live car objects (the race is paused meanwhile) and restores
// them on exit, so models, effects and audio need no replay-specific code.
const RATE = 30, SECONDS = 40, SIZE = RATE * SECONDS;
const BODY = ['x', 'z', 'yaw', 'vx', 'vz', 'speed', 'heave', 'pitch', 'roll', 'steering', 'rpm', 'gear', 'impact'];
const WHEEL = ['steer', 'compression', 'omega', 'brakeTemp'];
const ANGLES = new Set([2]);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const REPLAY_CAMS = ['tv', 'heli', 'chase', 'onboard'];

export class ReplayRecorder {
  constructor(carCount, wheels = 4) {
    this.stride = BODY.length + 2 + wheels * WHEEL.length;
    this.data = Array.from({ length: carCount }, () => new Float32Array(SIZE * this.stride));
    this.times = new Float64Array(SIZE); this.count = 0; this.head = 0; this.next = 0;
  }
  /** Stores one frame when `time` (race seconds) has moved on by 1/RATE. */
  capture(time, cars) {
    if (time < this.next) return;
    this.next = time + 1 / RATE;
    const i = this.head; this.times[i] = time;
    cars.forEach((c, n) => {
      const d = this.data[n]; if (!d) return; let o = i * this.stride;
      for (const k of BODY) d[o++] = c[k] ?? 0;
      d[o++] = c.controls?.throttle ?? 0; d[o++] = c.controls?.brake ?? 0;
      for (const w of c.wheels) for (const k of WHEEL) d[o++] = w[k] ?? 0;
    });
    this.head = (i + 1) % SIZE; this.count = Math.min(SIZE, this.count + 1);
  }
  get start() { return this.count ? this.times[(this.head - this.count + SIZE) % SIZE] : 0; }
  get end() { return this.count ? this.times[(this.head - 1 + SIZE) % SIZE] : 0; }
  /** Writes the state at race time `t` into the cars. */
  apply(t, cars) {
    if (this.count < 2) return;
    // Binary search over the ring for the frame pair around t.
    let lo = 0, hi = this.count - 1; const base = (this.head - this.count + SIZE) % SIZE, at = (j) => (base + j) % SIZE;
    t = clamp(t, this.times[at(0)], this.times[at(hi)]);
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.times[at(m)] <= t) lo = m; else hi = m; }
    const a = at(lo), b = at(hi), ta = this.times[a], u = clamp((t - ta) / Math.max(1e-6, this.times[b] - ta), 0, 1);
    cars.forEach((c, n) => {
      const d = this.data[n]; if (!d) return;
      let oa = a * this.stride, ob = b * this.stride;
      BODY.forEach((k, j) => {
        const va = d[oa + j], vb = d[ob + j];
        c[k] = ANGLES.has(j) ? va + wrapPi(vb - va) * u : k === 'gear' ? (u < .5 ? va : vb) : va + (vb - va) * u;
      });
      oa += BODY.length; ob += BODY.length;
      c.controls = { ...c.controls, throttle: d[oa] + (d[ob] - d[oa]) * u, brake: d[oa + 1] + (d[ob + 1] - d[oa + 1]) * u };
      oa += 2; ob += 2;
      c.wheels.forEach((w) => { for (const k of WHEEL) { w[k] = d[oa] + (d[ob] - d[oa]) * u; oa++; ob++; } });
    });
  }
  /** Saves and restores the live state around a replay. */
  save(cars) { return cars.map((c) => ({ body: Object.fromEntries(BODY.map((k) => [k, c[k]])), controls: { ...c.controls }, wheels: c.wheels.map((w) => Object.fromEntries(WHEEL.map((k) => [k, w[k]]))) })); }
  restore(cars, saved) { cars.forEach((c, n) => { const s = saved[n]; if (!s) return; Object.assign(c, s.body); c.controls = s.controls; c.wheels.forEach((w, i) => Object.assign(w, s.wheels[i])); }); }
}

/**
 * Broadcast camera director for replays: trackside TV cameras that zoom on the
 * car, a helicopter, the chase camera and an onboard view.
 */
export class ReplayDirector {
  constructor(camera, track) {
    this.camera = camera; this.track = track; this.mode = 'tv';
    this.pos = new THREE.Vector3(); this.look = new THREE.Vector3(); this.station = -1; this.snap = true;
    // TV stations every ~170 m on the side away from the pit lane, raised for a view over the barriers.
    const L = track.length, n = Math.max(8, Math.round(L / 170)), lat = track.halfWidth + (track.curbWidth ?? 1) + 11;
    this.stations = Array.from({ length: n }, (_, i) => {
      const s = (i + .5) * L / n, k = track.at(s, 0).curvature ?? 0;
      // Outside of a bend gives the long, head-on angle; straights alternate sides.
      const side = Math.abs(k) > .004 ? -Math.sign(k) : (i % 2 ? 1 : -1);
      const p = track.at(s, side * lat);
      return { s, x: p.x, z: p.z, y: 5.5 + (i % 3) * 2 };
    });
    this.fov0 = camera.fov;
  }
  setMode(mode) { this.mode = mode; this.snap = true; this.station = -1; }
  cycle() { this.setMode(REPLAY_CAMS[(REPLAY_CAMS.indexOf(this.mode) + 1) % REPLAY_CAMS.length]); return this.mode; }
  end() { this.camera.fov = this.fov0; this.camera.updateProjectionMatrix(); }
  update(car, dt) {
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw), cam = this.camera;
    const want = new THREE.Vector3(), aim = new THREE.Vector3(car.x + fx * 2, .9, car.z + fz * 2);
    let fov = this.fov0, stiff = 6;
    if (this.mode === 'tv') {
      const L = this.track.length, s = this.track.nearest(car.x, car.z).s;
      const ahead = (st) => ((st.s - s) % L + L * 1.5) % L - L / 2;
      // Hold a station until the car is well past it, then cut to the next one ahead.
      const cur = this.stations[this.station];
      if (!cur || ahead(cur) < -60 || ahead(cur) > 260) {
        let best = -1, bd = Infinity;
        this.stations.forEach((st, i) => { const d = ahead(st); if (d > 20 && d < bd) { bd = d; best = i; } });
        if (best !== this.station) { this.station = best; this.snap = true; }
      }
      const st = this.stations[this.station];
      want.set(st.x, st.y, st.z);
      const dist = Math.hypot(car.x - st.x, car.z - st.z);
      fov = clamp(2 * Math.atan(7 / Math.max(1, dist)) * 180 / Math.PI, 5, 55);
      stiff = 40;
    } else if (this.mode === 'heli') {
      want.set(car.x - fx * 28 + fz * 18, 42, car.z - fz * 28 - fx * 18); fov = 38; stiff = 2.5;
    } else if (this.mode === 'onboard') {
      want.set(car.x + fx * .35, 1.08, car.z + fz * .35); aim.set(car.x + fx * 30, .85, car.z + fz * 30); fov = 62;
      this.snap = true;
    } else {
      want.set(car.x - fx * 7.5, 2.6, car.z - fz * 7.5); aim.set(car.x + fx * 12, 1.1, car.z + fz * 12); stiff = 8;
    }
    const cut = this.snap; this.snap = false;
    if (cut) { this.pos.copy(want); this.look.copy(aim); }
    else { this.pos.lerp(want, 1 - Math.exp(-stiff * dt)); this.look.lerp(aim, 1 - Math.exp(-20 * dt)); }
    cam.position.copy(this.pos); cam.lookAt(this.look);
    if (Math.abs(cam.fov - fov) > .01) { cam.fov += (fov - cam.fov) * (cut || this.mode !== 'tv' ? 1 : 1 - Math.exp(-6 * dt)); cam.updateProjectionMatrix(); }
  }
}
