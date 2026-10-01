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
  constructor(track, ghost, { margin0 = 0.35, marginRate = 0.35 } = {}) {
    this.track = track; this.ghost = ghost; this.margin0 = margin0; this.marginRate = marginRate;
    this.list = [];       // [{id, poses: Float32Array(steps*4) x,z,yaw,margin}]
    this.seen = new Map(); // id -> {speed, t, accel}: observed longitudinal acceleration
    this.steps = 0;
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
      for (let k = 0; k < times.length; k++) {
        const t = times[k], h = t - prevT; prevT = t;
        // Speed follows the ghost's speed shape: an opponent brakes where a
        // fast car brakes and accelerates where a fast car accelerates.
        const shape = Math.max(8, g.speed(g.lapDistance(s))) / vg0;
        const vt = o.speed * Math.min(1.35, Math.max(0.35, shape));
        // Still accelerating: carry that on until the car reaches a pace a
        // little under the ghost's at the point it has got to.
        v = accel > 0.5 ? Math.max(vt, Math.min(v + accel * h, 0.95 * g.speed(g.lapDistance(s)))) : vt;
        s += v * h; speeds[k] = v;
        const decay = Math.exp(-t / 0.35);
        const lat = clampLat(o.lateral + latRate * 0.35 * (1 - decay), track.halfWidth + 1.2);
        const p = track.at(s, lat);
        poses[k * 4] = p.x; poses[k * 4 + 1] = p.z;
        poses[k * 4 + 2] = p.heading + headingErr * decay;
        poses[k * 4 + 3] = this.margin0 + this.marginRate * t; // uncertainty inflation, metres
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
