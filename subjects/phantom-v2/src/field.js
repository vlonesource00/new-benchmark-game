// Opponent occupancy for PHANTOM rollouts.
//
// Opponents are not corridors or lateral walls: they are predicted oriented
// boxes in world space, one pose per rollout step, checked against the
// rollout car's own box with the host's separating-axis geometry. The same
// predicted poses produce the host's slipstream term, so drafting and the
// dirty-air cost of a move emerge from the plant instead of being scripted.

const HALF_W = 0.98, HALF_L = 2.28;
const wrap = (x, n) => ((x % n) + n) % n;

export class OpponentField {
  constructor(track, ghost, { margin0 = 0.35, marginRate = 0.35, learn = true, latTau = 0.9, speedTau = 1.2, adaptMargin = true, learnMin = 2, marginFloor = true } = {}) {
    this.track = track; this.ghost = ghost; this.margin0 = margin0; this.marginRate = marginRate;
    this.learn = learn; this.latTau = latTau; this.speedTau = speedTau; this.adaptMargin = adaptMargin;
    this.learnMin = learnMin; this.marginFloor = marginFloor;
    this.list = [];       // [{id, poses: Float32Array(steps*4) x,z,yaw,margin}]
    this.seen = new Map(); // id -> {speed, t, accel}: observed longitudinal acceleration
    this.lines = new Map(); // v2: id -> learned {lat, v, has} per ghost station
    this.audit = new Map(); // v2: id -> {t0, times, poses, rate}: prediction error bookkeeping
    this.steps = 0;
  }

  // v2: learn each rival's own line and speed trace from what it is seen to
  // do (public pose and speed only), one value per ghost station. Gaps
  // between observations are filled by interpolation along the lap.
  observe(me, cars) {
    if (!this.learn) return;
    const g = this.ghost, n = g.n;
    for (const o of cars) {
      if (o === me) continue;
      let m = this.lines.get(o.id);
      if (!m) { m = { lat: new Float32Array(n), v: new Float32Array(n), has: new Uint8Array(n), u: null, q: 0, sp: 0 }; this.lines.set(o.id, m); }
      const u = g.lapDistance(o.s), q = o.lateral, sp = o.speed;
      // Off the road, spinning or crawling is not the rival's racing line.
      const valid = Math.abs(q) < this.track.halfWidth + 0.5 && sp > 6;
      if (valid && m.u !== null) {
        let du = u - m.u; if (du < -g.length / 2) du += g.length; else if (du > g.length / 2) du -= g.length;
        if (du > 0 && du < 40) {
          const i0 = Math.ceil(m.u / g.ds), i1 = Math.floor((m.u + du) / g.ds);
          for (let j = i0; j <= i1; j++) {
            const f = (j * g.ds - m.u) / du, i = ((j % n) + n) % n;
            const ql = m.q + (q - m.q) * f, vl = m.sp + (sp - m.sp) * f;
            if (m.has[i]) { m.lat[i] += 0.5 * (ql - m.lat[i]); m.v[i] += 0.5 * (vl - m.v[i]); if (m.has[i] < 255) m.has[i]++; }
            else { m.lat[i] = ql; m.v[i] = vl; m.has[i] = 1; }
          }
        }
      }
      if (valid) { m.u = u; m.q = q; m.sp = sp; } else m.u = null;
    }
  }

  learned(m, u) {
    const g = this.ghost, x = (((u % g.length) + g.length) % g.length) / g.ds;
    const i = Math.floor(x) % g.n, j = (i + 1) % g.n;
    // A station is trusted once seen learnMin times: a single lap-1 pass is
    // start traffic, not the rival's own line.
    if (m.has[i] < this.learnMin || m.has[j] < this.learnMin) return null;
    const f = x - Math.floor(x);
    return { lat: m.lat[i] + (m.lat[j] - m.lat[i]) * f, v: m.v[i] + (m.v[j] - m.v[i]) * f };
  }

  // v2: how fast this rival's real position drifts from what was predicted
  // for it, in metres per second of look-ahead. Sets its margin growth.
  marginRateFor(o, now) {
    if (!this.adaptMargin) return this.marginRate;
    const a = this.audit.get(o.id);
    if (!a) return this.marginRate;
    const dt = now - a.t0, T = a.times[a.times.length - 1];
    if (a.poses && dt >= 0.5 && dt <= T) {
      let k = 0; while (k < a.times.length - 1 && a.times[k] < dt) k++;
      const err = Math.hypot(a.poses[k * 4] - o.x, a.poses[k * 4 + 1] - o.z) / dt;
      a.rate = a.rate === null ? err : a.rate + 0.3 * (err - a.rate);
      a.poses = null;
    } else if (a.poses && dt > T) a.poses = null;
    if (a.rate === null) return this.marginRate;
    // With the floor, measured error can only widen a rival's margin, never
    // shrink it below the fixed rate.
    return Math.max(this.marginFloor ? this.marginRate : 0.15, Math.min(0.7, 0.1 + 1.2 * a.rate));
  }

  // times[k] is the rollout time at the END of step k.
  predict(me, cars, times, now = 0) {
    const track = this.track, g = this.ghost, L = track.length;
    this.list.length = 0; this.steps = times.length;
    for (const o of cars) {
      if (o === me) continue;
      // Measure each rival's acceleration from successive observations. A car
      // pulling away from the grid or out of a slow corner is predicted to
      // keep accelerating, not to sit where it is now for the whole horizon.
      const prev = this.seen.get(o.id), dtObs = prev ? now - prev.t : 0;
      let accel = prev?.accel ?? 0;
      if (prev && dtObs > 1e-3 && dtObs < 0.5) accel = 0.5 * accel + 0.5 * Math.max(-14, Math.min(8, (o.speed - prev.speed) / dtObs));
      else if (!prev || dtObs >= 0.5) accel = 0;
      this.seen.set(o.id, { speed: o.speed, t: now, accel });
      const ds = wrap(o.s - me.s + L / 2, L) - L / 2;
      if (ds < -40 || ds > 260) continue;
      const p0 = track.at(o.s);
      const headingErr = angleDiff(o.yaw, p0.heading);
      const uo = g.lapDistance(o.s);
      const vg0 = Math.max(8, g.speed(uo));
      const poses = new Float32Array(times.length * 4), speeds = new Float32Array(times.length);
      let s = o.s, prevT = 0, v = o.speed;
      const latRate = (o.vx * p0.nx + o.vz * p0.nz);
      const m = this.lines.get(o.id), L0 = m ? this.learned(m, uo) : null;
      const rate = this.marginRateFor(o, now);
      for (let k = 0; k < times.length; k++) {
        const t = times[k], h = t - prevT; prevT = t;
        const decay = Math.exp(-t / 0.35);
        const Ls = L0 ? this.learned(m, g.lapDistance(s)) : null;
        let lat;
        if (Ls) {
          // v2: the rival drives its own recorded lap; today's deviation from
          // it, in speed and across the road, fades out over about a second.
          const dv = Math.exp(-t / this.speedTau), dl = Math.exp(-t / this.latTau);
          v = Math.max(3, Ls.v + (o.speed - L0.v) * dv);
          lat = Ls.lat + (o.lateral - L0.lat) * dl + latRate * 0.35 * (1 - decay) * dl;
        } else {
          // Speed follows the ghost's speed shape: an opponent brakes where a
          // fast car brakes and accelerates where a fast car accelerates.
          const shape = Math.max(8, g.speed(g.lapDistance(s))) / vg0;
          const vt = o.speed * Math.min(1.35, Math.max(0.35, shape));
          // Still accelerating: carry that on until the car reaches a pace a
          // little under the ghost's at the point it has got to.
          v = accel > 0.5 ? Math.max(vt, Math.min(v + accel * h, 0.95 * g.speed(g.lapDistance(s)))) : vt;
          lat = o.lateral + latRate * 0.35 * (1 - decay);
        }
        s += v * h; speeds[k] = v;
        const p = track.at(s, clampLat(lat, track.halfWidth + 1.2));
        poses[k * 4] = p.x; poses[k * 4 + 1] = p.z;
        poses[k * 4 + 2] = p.heading + headingErr * decay;
        poses[k * 4 + 3] = this.margin0 + rate * t; // uncertainty inflation, metres
      }
      if (this.adaptMargin) {
        const a = this.audit.get(o.id) ?? { t0: -Infinity, times, poses: null, rate: null };
        if (!a.poses) { a.t0 = now; a.times = times; a.poses = poses.slice(); }
        this.audit.set(o.id, a);
      }
      this.list.push({ id: o.id, poses, speeds, ds, speed: o.speed, lateral: o.lateral });
    }
    return this.list;
  }

  // Host wake formula against predicted poses.
  wake(k, x, z) {
    let wake = 0;
    for (const o of this.list) {
      const P = o.poses, i = k * 4, yaw = P[i + 2];
      const dx = x - P[i], dz = z - P[i + 1];
      const sn = Math.sin(yaw), cs = Math.cos(yaw);
      const behind = -(dx * sn + dz * cs);
      if (behind <= 1.5 || behind >= 110) continue;
      const lateral = Math.abs(dx * cs - dz * sn), cone = 2.4 + behind * 0.05;
      if (lateral < cone) wake = Math.max(wake, Math.exp(-behind / 55) * (1 - (lateral / cone) ** 2));
    }
    return wake;
  }

  // Defence: how squarely this pose sits on the line of a car close behind,
  // 1 when directly in its path, fading with lateral offset and distance.
  cover(k, x, z, yaw) {
    let best = 0;
    const sn = Math.sin(yaw), cs = Math.cos(yaw);
    for (const o of this.list) {
      if (o.ds > -2 || o.ds < -30) continue;
      const P = o.poses, i = k * 4;
      const dx = x - P[i], dz = z - P[i + 1];
      const ahead = dx * sn + dz * cs;
      if (ahead < 3 || ahead > 30) continue;
      const side = dx * cs - dz * sn;
      best = Math.max(best, Math.exp(-(side * side) / 3) * (1 - ahead / 40));
    }
    return best;
  }

  // Car following: the highest speed at step k from which the car can still
  // brake to the pace of any predicted car ahead in its own lane before
  // closing inside a safe gap. Closed-loop seeds cap their target by it, so
  // each lane seed queues or pulls alongside instead of driving into a car.
  follow(k, x, z, yaw, speed, decel = 8) {
    let cap = Infinity;
    const sn = Math.sin(yaw), cs = Math.cos(yaw);
    for (const o of this.list) {
      const P = o.poses, i = k * 4, dx = P[i] - x, dz = P[i + 1] - z;
      const ahead = dx * sn + dz * cs, side = dx * cs - dz * sn;
      if (ahead < 0 || ahead > 60 || Math.abs(side) > 2 * HALF_W + 0.4 + P[i + 3]) continue;
      const room = ahead - 2 * HALF_L - 1.5 - 0.25 * speed, vo = o.speeds[k];
      cap = Math.min(cap, room > 0 ? Math.sqrt(vo * vo + 2 * decel * room) : vo + room);
    }
    return cap;
  }

  // Largest box overlap (m) of the rollout car against any prediction, or a
  // negative clearance when free. Uses SAT on the four box axes.
  contact(k, x, z, yaw) {
    let worst = -Infinity;
    const ar0 = Math.cos(yaw), ar1 = -Math.sin(yaw), af0 = Math.sin(yaw), af1 = Math.cos(yaw);
    for (const o of this.list) {
      const P = o.poses, i = k * 4, by = P[i + 2], m = P[i + 3];
      const dx = P[i] - x, dz = P[i + 1] - z;
      if (dx * dx + dz * dz > 64) { worst = Math.max(worst, -3); continue; }
      const br0 = Math.cos(by), br1 = -Math.sin(by), bf0 = Math.sin(by), bf1 = Math.cos(by);
      let depth = Infinity;
      for (let a = 0; a < 4; a++) {
        const x0 = a === 0 ? ar0 : a === 1 ? af0 : a === 2 ? br0 : bf0;
        const x1 = a === 0 ? ar1 : a === 1 ? af1 : a === 2 ? br1 : bf1;
        const dot = (v0, v1) => Math.abs(x0 * v0 + x1 * v1);
        const ov = HALF_W * (dot(ar0, ar1) + dot(br0, br1)) + (HALF_L) * (dot(af0, af1) + dot(bf0, bf1))
          + m - Math.abs(dx * x0 + dz * x1);
        if (ov < depth) depth = ov;
      }
      if (depth > worst) worst = depth;
    }
    return worst;
  }
}

function angleDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
function clampLat(q, m) { return Math.max(-m, Math.min(m, q)); }
