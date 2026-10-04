/**
 * REVOLUTION racecraft: rival models, lane candidates and the traffic speed
 * guard. Reads only public car state (s, lateral, speed, class).
 *
 * A lane is the racing line moved sideways by a smooth shift profile (see
 * Line.lane). Every 0.2 s the planner builds a handful of lanes (stay, return
 * to the line, fixed offsets, inside dive / cover of the next corner, outside
 * line), times each one from the current speed with its own QSS profile, and
 * scores it over a 4 s horizon against where each rival is predicted to be.
 */
const LEN = 5.4, WID = 2.1;           // footprint used for clearance (cars ~5.1 × 2.0 m)
const H = 4;                          // planning horizon, s
const wrapS = (d, L) => ((((d + L / 2) % L) + L) % L) - L / 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const b0 = (car, r) => Math.sign((r.x - car.x) * Math.cos(car.yaw) - (r.z - car.z) * Math.sin(car.yaw)) || 1;
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));

export class Rivals {
  constructor(track, bin = 10) {
    this.track = track; this.bin = bin; this.nb = Math.ceil(track.length / bin);
    this.map = new Map(); this.near = [];
  }
  /** Updates every rival's lap profile and returns the ones within `range` metres on track. */
  update(cars, me, dt, range = 160, refV = null) {
    const L = this.track.length; this.near.length = 0;
    for (const c of cars) {
      if (c === me || c.id === me.id) continue;
      let r = this.map.get(c.id);
      if (!r) { r = { id: c.id, v: new Float32Array(this.nb).fill(NaN), lat: new Float32Array(this.nb).fill(NaN), latRate: 0 }; this.map.set(c.id, r); }
      const b = Math.floor(((c.s % L) + L) % L / this.bin) % this.nb;
      // Only racing laps teach the profile: formation and cool-down laps run other lines.
      if (!refV || c.speed > 0.6 * refV(c.s)) {
        r.v[b] = Number.isFinite(r.v[b]) ? r.v[b] * 0.7 + c.speed * 0.3 : c.speed;
        r.lat[b] = Number.isFinite(r.lat[b]) ? r.lat[b] * 0.7 + c.lateral * 0.3 : c.lateral;
      }
      r.latRate = r.lastLat === undefined ? 0 : r.latRate * 0.8 + 0.2 * (c.lateral - r.lastLat) / Math.max(1e-3, dt); r.lastLat = c.lateral;
      Object.assign(r, { s: c.s, lateral: c.lateral, speed: c.speed, classId: c.classId, ds: wrapS(c.s - me.s, L), x: c.x, z: c.z, yaw: c.yaw, vx: c.vx ?? 0, vz: c.vz ?? 0, yawRate: c.yawRate ?? 0 });
      // Close by, track distance folds at kinks: use the separation along our heading instead.
      const dx = c.x - me.x, dz = c.z - me.z;
      r.fwd = Math.abs(r.ds) < 30 ? dx * Math.sin(me.yaw) + dz * Math.cos(me.yaw) : r.ds;
      r.out = Boolean(this.track.inPitLane?.(c.s, c.lateral)) || c.retired === true;
      if (!r.out && Math.abs(r.ds) < range) this.near.push(r);
    }
    return this.near;
  }
  profV(r, s) { const v = r.v[Math.floor(((s % this.track.length) + this.track.length) % this.track.length / this.bin) % this.nb]; return v; }
  profLat(r, s) { return r.lat[Math.floor(((s % this.track.length) + this.track.length) % this.track.length / this.bin) % this.nb]; }
  /**
   * Predicted (s, lateral) samples every `step` seconds over the horizon. Speed
   * follows the rival's own learnt profile (or our line's, scaled) so a car
   * ahead is expected to brake where it braked last lap.
   */
  predict(r, ref, step = 0.1, refLat = null, acc = null) {
    const n = Math.ceil(H / step) + 1, s = new Float64Array(n), lat = new Float64Array(n);
    const own = (x) => { const v = this.profV(r, x); return Number.isFinite(v) ? v : ref(x); };
    const ratio0 = clamp(r.speed / Math.max(5, own(r.s)), 0.6, 1.4);
    // Without a learnt profile a fast rival is assumed to drive our racing line.
    const latAt = (x) => { const l = this.profLat(r, x); return Number.isFinite(l) ? l : refLat ? refLat(x) : NaN; };
    const lat0 = latAt(r.s);
    // A car off the track or far below its usual speed is a hazard: assume it keeps slowing.
    const hazard = r.hazard = Math.abs(r.lateral) > this.track.halfWidth + 0.5 || r.speed < 0.6 * own(r.s);
    // A car alongside is boxed in by us: it still swings with its line through a corner, but
    // only half as far (holding it at a fixed lateral makes a centreline-parallel arc, tighter
    // and slower than any racing line, look like the only way past it).
    const boxed = Math.abs(r.fwd) < LEN + 4, swing = boxed ? (this.boxSwing ?? 0.5) : 1;
    const px = new Float64Array(n), pz = new Float64Array(n);
    let x = r.s, vp = r.speed; s[0] = x; lat[0] = r.lateral; px[0] = r.x; pz[0] = r.z;
    const p0 = this.track.at(r.s), ox = r.x - (p0.x + p0.nx * r.lateral), oz = r.z - (p0.z + p0.nz * r.lateral);
    // Short term the car goes where its velocity and yaw rate take it; the track
    // frame folds at kinks, so the world-frame guess carries the first half-second.
    let kx = r.x, kz = r.z, kh = Math.atan2(r.vx ?? 0, r.vz ?? 0); const kv = Math.hypot(r.vx ?? 0, r.vz ?? 0);
    for (let k = 1; k < n; k++) {
      const t = k * step, ratio = 1 + (ratio0 - 1) * Math.exp(-t / (this.ratioTau ?? 3));
      // A rival accelerates no faster than a car of its kind can.
      vp = hazard ? r.speed * Math.exp(-t / 1.5) : Math.min(own(x) * ratio, acc ? vp + acc(vp) * step : Infinity);
      x += vp * step; s[k] = x;
      const pl = latAt(x), w = Math.min(1, t / 1.5);
      lat[k] = r.lateral + clamp(r.latRate, -4, 4) * Math.min(t, 0.3) + (!hazard && Number.isFinite(pl) && Number.isFinite(lat0) ? (pl - lat0) * w * swing : 0);
      // Track frame → world, carrying the current mapping error so the prediction starts exactly at the car.
      const q = this.track.at(x), fade = Math.exp(-t / 0.8);
      px[k] = q.x + q.nx * lat[k] + ox * fade; pz[k] = q.z + q.nz * lat[k] + oz * fade;
      kh += clamp(r.yawRate ?? 0, -0.8, 0.8) * Math.exp(-t / 0.6) * step; kx += kv * Math.sin(kh) * step; kz += kv * Math.cos(kh) * step;
      const wk = Math.exp(-t / 0.5); px[k] = wk * kx + (1 - wk) * px[k]; pz[k] = wk * kz + (1 - wk) * pz[k];
    }
    return { s, lat, px, pz, step };
  }
}

export class Racecraft {
  constructor(driver) {
    this.d = driver; this.rivals = new Rivals(driver.track);
    this.lane = null; this.clock = 0; this.state = 'FREE'; this.kind = 'line'; this.hold = 0;
    this.coverUsed = false; this.lastApex = -1; this.nudge = 0;
  }
  reset() { this.lane = null; this.clock = 0; this.state = 'FREE'; this.kind = 'line'; this.coverUsed = false; this.nudge = 0; this.blocker = null; this.move = null; this.draft = false; }

  /** Our track lateral offset from the base line right now. */
  offsetNow(i) { return this.lane ? this.lane.shift[i] : 0; }
  offsetAt(i) { return this.offsetNow(i); }

  /**
   * Shift profile from station i: current offset → target over a ramp, hold, return to the line.
   * `abs` targets a track lateral instead of an offset from the line, so a held
   * position stays put where the line itself sweeps across the track.
   */
  profile(i, o0, target, holdTo, back = 90, v = 40, abs = false, rampMin = 0, aLat = 4) {
    const line = this.d.line, N = line.N, shift = new Float64Array(N), { left, right } = this.room(), hw = line.track.halfWidth;
    // Track laterals and the edges come from the room along the line's own normals: where the
    // centreline folds (a kink) its lateral jumps metres between stations, and a lane built
    // on it swings across the road there, a kink no car can take at speed.
    const lo = (j) => Math.min(0, 1.15 - left[j]), hi = (j) => Math.max(0, right[j] - 1.15);
    const T = (j) => (abs ? (target + hw) * (left[j] + right[j]) / (2 * hw) - left[j] : target), Tr = T(line.idx(i + Math.round(holdTo / line.ds)));
    // Cosine ramp sized so the extra lateral acceleration stays under aLat (~4 m/s²).
    // The start slope s0 adds a Hermite term (slope s0 at the car, gone by the end of the
    // ramp); its peak curvature 4·s0/ramp is held to ~2·aLat as well.
    const s0 = this.slope0 ?? 0;
    const ramp = Math.max(25, rampMin, Math.PI * v * Math.sqrt(Math.abs(T(i) - o0) / (2 * aLat)), 2 * Math.abs(s0) * v * v / aLat);
    back = Math.max(back, Math.PI * v * Math.sqrt(Math.abs(Tr) / 8));
    // Behind the car (road it has already driven) the offset blends to zero no tighter
    // than the ramp ahead: a sharp blend there would be a kink whose speed the
    // acceleration pass carries forward to the car.
    const behind = Math.max(40, 1.5 * Math.PI * v * Math.sqrt(Math.abs(o0) / (2 * aLat))), K = Math.ceil(behind / line.ds) + 1;
    for (let k = -K; k < N - K; k++) {
      const j = line.idx(i + k), d = k * line.ds;
      let x;
      if (d < 0) x = o0 * smooth(1 + d / behind) + s0 * d * (1 + d / behind) ** 2;
      else if (d < ramp) x = o0 + (T(j) - o0) * smooth(d / ramp) + s0 * d * (1 - d / ramp) ** 2;
      else if (d < holdTo) x = T(j);
      else x = Tr * (1 - smooth((d - Math.max(ramp, holdTo)) / back));
      if (d > Math.max(ramp, holdTo) + back) x = 0;
      shift[j] = clamp(x, lo(j), hi(j));
    }
    // The edge clamp is per station: where the line runs along the edge it leaves kinks
    // that would make the lane slow. Smooth it out (1-2-3-2-1 kernel, three passes).
    const end = Math.ceil((Math.max(ramp, holdTo) + back) / line.ds) + 6;
    if (end + K + 6 < N) {
      const tmp = new Float64Array(end + K + 13);
      for (let pass = 0; pass < 3; pass++) {
        for (let k = -K - 6; k <= end + 6; k++) { let a = 0; for (let q = -2; q <= 2; q++) a += (3 - Math.abs(q)) * shift[line.idx(i + k + q)]; tmp[k + K + 6] = a / 9; }
        for (let k = -K - 6; k <= end + 6; k++) shift[line.idx(i + k)] = tmp[k + K + 6];
      }
      for (let k = -K - 6; k <= end + 6; k++) { const j = line.idx(i + k); shift[j] = clamp(shift[j], lo(j), hi(j)); }
    }
    return shift;
  }
  /** Track lateral (in the room's frame, see profile) of offset x from the line at station j. */
  absLat(j, x) { const { left, right } = this.room(), hw = this.d.line.track.halfWidth; return -hw + (x + left[j]) * 2 * hw / Math.max(1, left[j] + right[j]); }
  /** Room from each line point to the track edges along its normals (left, right), m. */
  room() {
    const line = this.d.line;
    if (this.rooms?.line === line) return this.rooms;
    const N = line.N, left = new Float64Array(N), right = new Float64Array(N), tr = line.track, hw = tr.halfWidth;
    for (let j = 0; j < N; j++) {
      const c = Math.cos(line.h[j]), s = Math.sin(line.h[j]);
      for (const [side, out] of [[1, right], [-1, left]]) {
        let x = 0;
        while (x < 2.5 * hw && Math.abs(tr.nearest(line.px[j] + c * side * (x + 0.25), line.pz[j] - s * side * (x + 0.25)).lateral) <= hw) x += 0.25;
        out[j] = x;
      }
    }
    // A fold can make a point beside the line look outside for a station or two: the room
    // never changes faster than the road can, so take the neighbours' where it dips alone.
    for (const a of [left, right]) { const b = a.slice(); for (let j = 0; j < N; j++) a[j] = Math.max(b[j], Math.min(b[line.idx(j - 1)], b[line.idx(j + 1)])); }
    // At a fold the corridor's edge has corners (its wedge on the outside of the kink): a lane
    // held against it would have them too. The room used is the lower envelope that widens
    // no faster than 1 m in 20, then smoothed, so a lane along an edge stays drivable.
    const m = 0.05 * line.ds;
    for (const a of [left, right]) {
      for (let r = 0; r < 2; r++) { for (let j = 0; j < N; j++) a[j] = Math.min(a[j], a[line.idx(j - 1)] + m); for (let j = N - 1; j >= 0; j--) a[j] = Math.min(a[j], a[line.idx(j + 1)] + m); }
      for (let pass = 0; pass < 4; pass++) { const b = a.slice(); for (let j = 0; j < N; j++) { let t = 0; for (let q = -2; q <= 2; q++) t += (3 - Math.abs(q)) * b[line.idx(j + q)]; a[j] = t / 9; } }
    }
    return (this.rooms = { line, left, right });
  }

  /** Next corner ahead: braking start, apex station, apex direction (+1 right). */
  nextCorner(i) {
    const line = this.d.line, v = line.v, N = line.N;
    let brake = -1;
    for (let k = 1; k < 220; k++) {
      const j = line.idx(i + k), p = line.idx(j - 1);
      if (brake < 0 && v[j] < v[p] - 0.15) brake = k;
      if (brake >= 0 && v[line.idx(j + 1)] > v[j] + 0.05) return { brakeAt: brake, apexAt: k, dir: Math.sign(line.ks[j]) || 1, vApex: v[j] };
    }
    return null;
  }

  /** Time our car along `lane` from station i at speed v0; returns per-station times and feasibility. */
  timeLane(lane, i, v0, model) {
    const steps = [], N = lane.N, b0 = model.brake(v0); let t = 0, v = v0, over = 0, dist = 0;
    for (let k = 0; k < N && t < H; k++) {
      const j = lane.idx(i + k);
      // The slowest we can be by here; a lane asking for less is not reachable.
      const vMin = Math.sqrt(Math.max(0, v0 * v0 - 2 * b0 * dist));
      if (vMin > lane.v[j] + 0.5) over = Math.max(over, vMin - lane.v[j]);
      v = Math.min(v, lane.v[j]);
      steps.push({ j, t, v });
      const vn = Math.min(lane.v[lane.idx(j + 1)], Math.sqrt(v * v + 2 * lane.len[j] * model.drive(v)));
      t += lane.len[j] / Math.max(1, 0.5 * (v + vn)); v = vn; dist += lane.len[j];
    }
    return { steps, over };
  }

  /** Score a lane against every nearby rival's prediction. Higher is better. */
  score(lane, i, car, preds, info) {
    const d = this.d, line = d.line, L = line.track.length;
    const { steps, over } = this.timeLane(lane, i, Math.max(1, car.speed), d.model);
    let progress = 0, penalty = over * 25, blockedAt = Infinity, blockP = null;
    const s0 = line.st[i];
    for (const st of steps) {
      if (st.t > blockedAt) break;
      const sj = line.st[st.j], hj = lane.h[st.j], sh = Math.sin(hj), ch = Math.cos(hj);
      for (const p of preds) {
        const k = Math.min(p.s.length - 1, Math.round(st.t / p.step));
        const dx = p.px[k] - lane.px[st.j], dz = p.pz[k] - lane.pz[st.j];
        const ds = dx * sh + dz * ch, dl = Math.abs(dx * ch - dz * sh);
        const zone = WID + (p.alongside ? 0.4 : 0.9 + 0.04 * Math.abs(st.v - p.r.speed));
        if (Math.abs(ds) < LEN + 0.6 && dl < zone) {
          const depth = zone - dl, w = Math.max(0.05, steps.length > 1 ? steps[1].t : 0.1);
          if (ds > 1.5 && !p.alongside) { if (dl < WID + 0.3 && st.t < blockedAt) { blockedAt = st.t; info.blocker = p.r.id; blockP = p; } }   // its gearbox: follow instead
          else if (ds < -2.5 && !p.alongside) penalty += 20 * depth * w;   // a car behind must avoid us (iRacing: the overtaker's job)
          else penalty += 110 * depth * w * (dl < WID ? 3 : 1);   // alongside: graded, worse when actually touching (a rub is racing)
        }
      }
      progress = wrapS(sj - s0, L);
    }
    // Blocked: from that time on we only match the car ahead.
    // Blocked: the lane is worth its own pace, but never more than following the
    // car ahead at a towing gap; a slower lane beside it buys nothing.
    { const last = steps.at(-1); progress = wrapS(line.st[last.j] - s0, L) + (H - last.t) * last.v; }
    if (blockP) progress = Math.min(progress, wrapS(blockP.s.at(-1) - s0, L) - LEN - 2.5 - 0.06 * car.speed);
    // Positions: being ahead of a rival at the horizon is worth much more than metres.
    let pos = 0;
    for (const p of preds) {
      const ours = wrapS(s0 + progress - p.s.at(-1), L);
      if (p.r.fwd > 0 && ours > LEN) pos += 30;
      // ...and a slow lane that lets a car behind through loses one.
      else if (p.r.fwd < 0 && p.r.classId === car.classId && ours < LEN) pos -= 30;
    }
    info.blockedAt = blockedAt;
    const extra = info.extra(lane);
    info.parts = [progress, pos, penalty, extra, over];
    return progress + pos - penalty - extra;
  }

  /**
   * Chooses the lane for this step and returns the speed cap from the car ahead.
   */
  update(car, cars, dt, i, eBase = null) {
    const d = this.d, line = d.line, L = line.track.length;
    const near = this.rivals.update(cars, car, dt, 160, (s) => line.v[this.stationOfS(s)]);
    this.clock -= dt; this.hold -= dt; this.t = (this.t ?? 0) + dt;
    // Plans start where the car is: off its lane by more than 1.5 m (after the
    // formation, a moment of avoidance), the real offset from the line counts and
    // the old lane is no longer a candidate (chasing it would yank the car across).
    const lo = this.offsetNow(i);
    this.offLane = eBase !== null && (Math.abs(eBase - lo) > 1.5 || Boolean(this.d.passive));
    const o0 = this.offLane ? eBase : lo;
    // ...and leave in the direction the car is already going: the lane's slope at the car
    // (its own on the lane, the car's course off it), so a re-plan never asks for a yaw step.
    if (this.offLane || !this.lane) { const h = car.yaw + Math.atan2(car.v, Math.max(2, car.u)) - line.heading(i, 0.5); this.slope0 = this.offLane ? clamp(Math.sin(Math.atan2(Math.sin(h), Math.cos(h))), -0.2, 0.2) : 0; }
    else this.slope0 = (this.lane.shift[line.idx(i + 1)] - this.lane.shift[line.idx(i - 1)]) / (2 * line.ds);
    if (this.offLane && !this.move && !this.d.passive) this.clock = Math.min(this.clock, 0);
    // On the in-lap the pit approach owns the lane; only the guards still act.
    if (this.pit) { if (this.move) this.endMove(); this.state = 'PIT'; if (near.length) { this.sideGuard(car, near, dt); return this.guard(car, near, i); } return Infinity; }
    if (this.move && !this.moveStep(car, i)) this.endMove();
    if (!near.length) {
      if (this.move) this.endMove();
      // The way back is ramped for the speed the car carries, so its profile never asks for a brake stab mid-corner.
      if (Math.abs(o0) > 0.05 && this.kind !== 'return') { this.lane = line.lane(this.profile(i, o0, 0, 0, 90, Math.max(40, car.speed), false, 0, 2)); this.lane.speeds(d.model, d.lambda); this.kind = 'return'; }
      if (this.lane && Math.abs(o0) < 0.05) { this.lane = null; this.kind = 'line'; }
      this.state = 'FREE'; this.nudge *= Math.exp(-3 * dt);
      return Infinity;
    }
    if (this.move) { this.state = 'ATTACK'; this.draft = false; }
    else if (this.clock <= 0) { this.clock = 0.2; this.plan(car, near, i, o0); }
    this.sideGuard(car, near, dt);
    return this.guard(car, near, i);
  }

  plan(car, near, i, o0) {
    const d = this.d, line = d.line, L = line.track.length;
    const ref = (s) => d.line.v[line.idx(Math.round(this.stationOfS(s)))] ?? car.speed;
    const preds = near.filter((r) => Math.abs(r.fwd) < 120).map((r) => ({ r, alongside: Math.abs(r.fwd) < LEN + 1, ...this.rivals.predict(r, ref, 0.1, (s) => line.lat[this.stationOfS(s)], (v) => d.model.drive(v)) }));
    const hazard = preds.some((p) => p.r.hazard && p.r.fwd > -10 && p.r.fwd < 100);
    const corner = this.nextCorner(i);
    const braking = d.mode === 'BRAKE' || (corner && corner.brakeAt * line.ds < 25);
    // A car overlapping us (within ~half a length) is alongside: neither the car to attack
    // nor the one to cover, else a side-by-side start flips between the two every plan.
    const behind = near.filter((r) => r.fwd < -3 && r.fwd > -20 && r.classId === car.classId && r.speed > car.speed - 1);
    const ahead = near.filter((r) => r.fwd > 3 && r.fwd < 60);
    const lead = ahead.sort((a, b) => a.ds - b.ds)[0];
    // Being lapped by a faster class: hold a predictable line.
    const lapped = near.some((r) => r.fwd < 0 && r.fwd > -60 && r.classId !== car.classId && r.classId === 'lmdh');
    // A new corner ahead re-arms the single defensive move.
    const apexId = corner ? line.idx(i + corner.apexAt) : -1;
    if (Math.abs(wrapS((apexId - this.lastApex) * line.ds, L)) > 40) { this.coverUsed = false; this.lastApex = apexId; }

    // Same-class car ahead on a straight: close up into its tow (the guard follows tighter).
    const db = corner ? corner.brakeAt * line.ds : Infinity;
    this.draft = Boolean(lead && lead.classId === car.classId && !hazard && !lapped && db > 70);
    if (lead && !lapped && !hazard && (this.tryMove(car, lead, i, o0, corner, apexId))) return;

    const cands = [];
    // Nobody returns to the line across a car alongside: holds run until it is clear.
    const side = near.some((r) => Math.abs(r.fwd) < LEN + 3);
    const add = (kind, target, holdTo, abs = false, back = 90, keepSide = true) => cands.push({ kind, target, lane: line.lane(this.profile(i, o0, target, side && keepSide ? Math.max(holdTo, 140) : holdTo, back, Math.max(20, car.speed), abs)) });
    add('stay', o0, 200);
    // Holding a fixed lateral runs parallel to the centreline: fine on a straight, but through a
    // corner a tighter, slower arc than the line's that slides the car. It ends where the braking does.
    if (corner && corner.brakeAt * line.ds < 160) { const bD = Math.max(20, corner.brakeAt * line.ds); add('hold', this.absLat(i, o0), bD, true, 60, false); }
    else add('hold', this.absLat(i, o0), 160, true);
    if (this.lane && !this.offLane && (this.kind !== 'tow' || this.draft)) cands.push({ kind: this.kind, lane: this.lane, keep: true });
    add('line', 0, 0);
    // Offset lanes only matter with someone close; in clean air the line is the answer.
    const engaged = near.some((r) => r.fwd > -12 && r.fwd < 70);
    if ((!lapped && engaged) || hazard) {
      for (const t of [-4.5, -2.4, 2.4, 4.5]) add(t < 0 ? 'left' : 'right', t, 160);
      if (corner) {
        const B = line.track.halfWidth - 1.3, turn = line.idx(i + corner.brakeAt);
        const holdTo = (corner.apexAt + 6) * line.ds;
        // The inside is owned to the braking point; from there the car takes the line's own
        // way into the apex (which is on the inside anyway). Hugging the edge all the way
        // there is a tighter, slower arc that hands the corner to the car outside.
        const brakeD = Math.max(30, corner.brakeAt * line.ds);
        add('inside', corner.dir * B, brakeD, true, Math.max(30, holdTo - brakeD), false);
        add('outside', -corner.dir * B, holdTo, true);
      }
    }
    // In a same-class car's tow on a straight: its line, a car's length behind, is the lane that
    // closes the gap (the wake cuts drag) and sets up the pull-out of the move.
    // The tow is a straight-line lane: back on the line by the braking point, never through the corner.
    if (this.draft && lead.fwd < 45 && Math.abs(lead.lateral - car.lateral) > 0.8) add('tow', lead.lateral, Math.min(160, db - 60), true, 50, false);
    // How far a lane strays from the current plan over the next 60 m: a different kind of lane
    // that runs within a metre of it is no move at all (no weave to forbid, nothing to hold to).
    const cur = this.lane, n = Math.round(60 / line.ds);
    const moveOf = (lane) => { let m = 0; for (let k = 0; k <= n; k += 2) { const j = line.idx(i + k); m = Math.max(m, Math.abs(lane.shift[j] - (cur ? cur.shift[j] : 0))); } return clamp((m - 0.5) / 1.5, 0, 1); };
    const extra = (kind) => (lane) => {
      let c = 0;
      const mv = kind === this.kind ? 0 : moveOf(lane);
      // Lateral moves under braking are illegal unless they avoid contact.
      if (braking && kind !== this.kind && !hazard) c += 40 * mv;
      // Defence: one move toward the inside before the braking zone, then hold it.
      if (behind.length && corner && kind === 'inside' && !this.coverUsed) c -= 22;
      if (behind.length && kind !== this.kind && this.coverUsed) c += 30 * mv;
      if (lapped && kind !== this.kind) c += 25 * mv;
      // No weaving in front of a car: only the line, staying put or the one cover move.
      if (behind.length && !['line', 'stay', 'hold', 'inside', 'return', 'move'].includes(kind) && !ahead.length) c += 15;
      // Leaving the optimal line has to buy something.
      c += 0.6 * Math.abs(lane.shift[(this.d.cursor + 12) % lane.N] ?? 0);
      if (kind === 'tow') c -= 10;
      // Hysteresis: staying with the current plan is worth a little.
      if (kind === this.kind) c -= 3;
      return c;
    };
    let best = null, bestScore = -Infinity;
    for (const c of cands) {
      if (c.lane !== this.lane || !c.lane.v) c.lane.speeds(d.model, d.lambda);
      const info = { leadSpeed: lead?.speed, extra: extra(c.kind) };
      const sc = this.score(c.lane, i, car, preds, info);
      c.score = sc; c.info = info;
      if (sc > bestScore) { bestScore = sc; best = c; }
    }
    // Following: leaving the line must be predicted to gain the place (its +30 in the score), else
    // follow on the line. Only with no braking zone inside the horizon may a lane that merely
    // gains metres (a pull-out of the tow on a long straight) set up a pass beyond it.
    const lineC = cands.find((c) => c.kind === 'line');
    const gains = best.info.parts[1] > (lineC?.info.parts[1] ?? 0), straight = db > car.speed * H;
    if (lead && !side && !hazard && best.kind !== 'line' && best.kind !== 'tow' && lineC && !gains && !(straight && best.score - lineC.score >= 15)) best = lineC;
    if (best.lane !== this.lane) {
      if (best.kind === 'inside' && behind.length) this.coverUsed = true;
      this.lane = best.kind === 'line' && Math.abs(o0) < 0.05 ? null : best.lane; this.kind = best.kind;
    }
    // The chosen lane runs into this car within the horizon: the guard follows it whatever its lateral now.
    this.blocker = best.info.blockedAt < 2 ? best.info.blocker : null;
    this.state = lapped ? 'YIELD' : behind.length && this.kind === 'inside' ? 'COVER' : lead && this.kind !== 'line' ? 'ATTACK' : lead ? 'FOLLOW' : behind.length ? 'DEFEND' : 'RACE';
    this.lastCands = cands;
    this.cands = cands.map((c) => `${c.kind}${c.keep ? "*" : ""}:${c.score.toFixed(0)}`).join(" ");
  }

  /**
   * Committed overtake. The planner re-chooses every 0.2 s over a 4 s horizon,
   * too short to see a pass that is set up on a straight and finished under
   * braking. A move: from the tow, pull out to the inside of the next corner so
   * the ramp ends at its braking point, brake on a bolder profile (+3 % grip
   * use) and hold the inside through the apex. One try per corner; it is
   * dropped while still behind if the inside closes or the braking zone is
   * reached without an overlap.
   */
  tryMove(car, lead, i, o0, corner, apexId) {
    const d = this.d, line = d.line, L = line.N * line.ds;
    if (!corner) return false; if (this.t < (this.moveCool ?? 0)) return false; if (this.moveApex === apexId) return false;
    if (lead.fwd > 30) return false; if (lead.fwd < LEN - 1) return false;
    const B = line.track.halfWidth - 1.3, db = corner.brakeAt * line.ds, da = corner.apexAt * line.ds, v = Math.max(20, car.speed), aLat = 6;
    // The inside of the next corner if there is a car's width of room there, now and
    // where the rival usually is at the braking point; else, with a long run to the
    // braking zone, the other side to pass on the straight.
    // Room both beside where it is now and where it usually is at the braking point.
    const rl = this.rivals.profLat(lead, lead.s + db), lats = Number.isFinite(rl) ? [lead.lateral, rl] : [lead.lateral];
    const roomTo = (dir) => B - Math.max(...lats.map((x) => dir * x));
    // The inside is where the line apexes (in a complex the slowest point can lie on the other side of the turn's sign).
    const apexLat = line.lat[line.idx(i + corner.apexAt)], inDir = Math.abs(apexLat) > 2 ? Math.sign(apexLat) : corner.dir;
    const dir = roomTo(inDir) >= WID + 1.0 ? inDir : db > 150 && roomTo(-inDir) >= WID + 1.0 ? -inDir : 0;
    if (!dir) return false;
    // Beside the rival's usual line with a car's width and a margin to spare, not at the edge:
    // at a fast kink the edge is a tighter path than the line.
    const rivalAt = dir > 0 ? Math.max(...lats) : Math.min(...lats), target = clamp(rivalAt + dir * (WID + 1.1), -B, B), ramp = Math.PI * v * Math.sqrt(Math.abs(target - line.lat[i] - o0) / (2 * aLat));
    if (ramp > da - 10) return false;
    // From the tow the pull-out may come early; otherwise only near the braking zone, where the gains are.
    const tow = car.aero?.wake > 0.3 && lead.fwd < 14;
    if (db > ramp + (tow ? 80 : 25)) return false;
    // Held to the braking point (or the end of the ramp), then into the line's own apex.
    const holdTo = Math.max(db, ramp), lane = line.lane(this.profile(i, o0, target, holdTo, Math.max(30, da - holdTo), v, true, 0, aLat));
    lane.boost = 1.03; lane.speeds(d.model, d.lambda * lane.boost);
    // Overlap at the apex: our arrival along the move lane against the rival's on its learnt profile.
    const apexJ = line.idx(i + corner.apexAt), tUs = this.arrive(lane, i, corner.apexAt, car.speed, car.aero?.wake ?? 0, ramp), tR = this.arriveRival(lead, line.st[apexJ]);
    const behindAtApex = (tUs - tR) * corner.vApex;
    if (!(behindAtApex < LEN * 0.9)) return false;
    this.lane = lane; this.kind = 'move'; this.state = 'ATTACK'; this.blocker = null; this.draft = false; this.moveApex = apexId;
    this.move = { id: lead.id, apex: apexJ, until: this.t + tUs + 2, side: dir === inDir ? 'inside' : 'outside', target, dir, fwd0: lead.fwd, brakeJ: line.idx(i + corner.brakeAt), apexAt: corner.apexAt - corner.brakeAt };
    this.moves = (this.moves ?? 0) + 1;
    return true;
  }
  /** Time for us to cover `n` stations of `lane` from station i at speed v0 (lane-speed and drive limited). */
  arrive(lane, i, n, v0, wake = 0, towDist = 0) {
    const m = this.d.model; let t = 0, v = Math.min(v0, lane.v[i]), dist = 0;
    for (let k = 0; k < n; k++) {
      // The tow (42 % less drag at full wake) lasts while we are still pulling out of it.
      const tow = dist < towDist ? 0.42 * wake * m.dragK * v * v * (1 - dist / towDist) : 0;
      const j = lane.idx(i + k), vn = Math.min(lane.v[lane.idx(j + 1)], Math.sqrt(v * v + 2 * lane.len[j] * (m.drive(v) + tow)));
      t += lane.len[j] / Math.max(1, 0.5 * (v + vn)); v = vn; dist += lane.len[j];
    }
    return t;
  }
  /** Time for a rival to reach track distance sEnd on its learnt speed profile (our line's where unknown). */
  arriveRival(r, sEnd) {
    const L = this.d.line.track.length, dist = wrapS(sEnd - r.s, L), step = 5;
    let t = 0;
    for (let x = 0; x < dist; x += step) {
      const v = this.rivals.profV(r, r.s + x), ref = this.d.line.v[this.stationOfS(r.s + x)];
      const w = Math.exp(-x / 40), vp = Number.isFinite(v) ? v : ref;
      t += Math.min(step, dist - x) / Math.max(5, w * r.speed + (1 - w) * vp);
    }
    return t;
  }
  /** Advances a move; false when it is done or dropped. */
  moveStep(car, i) {
    const m = this.move, r = this.rivals.map.get(m.id), line = this.d.line, L = line.N * line.ds;
    if (!r || r.out || this.t > m.until) return false;
    const pastApex = wrapS((i - m.apex) * line.ds, L);
    if (pastApex > 12) { if (r.fwd < 0) this.passes = (this.passes ?? 0) + 1; return false; }
    if (r.fwd > LEN * 0.6) {
      // Still behind: the rival covering our lane, or no overlap by the turn-in, ends it.
      const covered = Math.abs(r.lateral - m.target) < WID + 0.2;
      const lost = r.fwd > m.fwd0 + 6;
      const late = pastApex > -8;
      if (covered || lost || late) { this.moveCool = this.t + 1.5; this.aborts = (this.aborts ?? 0) + 1; return false; }
    }
    return true;
  }
  endMove() {
    this.move = null; this.clock = 0;
    // The bold profile belongs to the move only.
    if (this.lane?.boost) { this.lane.boost = 1; this.lane.speeds(this.d.model, this.d.lambda); }
  }

  /**
   * Side guard: a car overlapping us keeps ≥ 3 m centre to centre. The nudge
   * moves our target away from it (rate-limited), whatever the lane says.
   */
  sideGuard(car, near, dt) {
    const B = this.d.track.halfWidth - 1.0;
    let want = 0, rate = 4; this.reflexCap = Infinity;
    for (const r of near) {
      const b = this.body(car, r);
      if (Math.abs(b.lon) > LEN + 2) continue;
      const sep = b.lat, need = 2.4 - Math.abs(sep);
      if (need > 0) want += -Math.sign(sep || 1) * need;
    }
    // Reflex: 1.5 s look-ahead, us along our own path, them by velocity and yaw
    // rate. A car ahead crossing into our path caps our speed to what can still
    // stop behind it; only a car beside or behind moves us sideways.
    const path = this.lane ?? this.d.line, i = this.d.cursor, v = Math.max(1, car.speed), brake = this.d.model.brake(v);
    for (const r of near) {
      if (r.fwd < -12 || r.fwd > 80) continue;
      let x = r.x, z = r.z, hv = Math.atan2(r.vx, r.vz); const vr = Math.hypot(r.vx, r.vz);
      for (let t = 0.1; t <= 1.5; t += 0.1) {
        hv += clamp(r.yawRate, -0.6, 0.6) * 0.1 * Math.exp(-t); x += vr * Math.sin(hv) * 0.1; z += vr * Math.cos(hv) * 0.1;
        const j = path.idx(i + Math.round(v * t / path.ds)), h = path.h[j];
        const dx = x - path.px[j], dz = z - path.pz[j], lon = dx * Math.sin(h) + dz * Math.cos(h), lat = dx * Math.cos(h) - dz * Math.sin(h) - this.nudge;
        if (Math.abs(lon) > LEN - 0.2 || Math.abs(lat) > WID + 0.4) continue;
        if (r.fwd > LEN + 1) {
          const room = Math.max(0, r.fwd - LEN - 2);
          this.reflexCap = Math.min(this.reflexCap, Math.sqrt(vr * vr + 2 * brake * 0.75 * room));
        } else if (t < 0.6) { want += -Math.sign(lat || -b0(car, r)) * (WID + 0.3 - Math.abs(lat)); rate = 5; }
        break;
      }
    }
    // Never pushed past the edge, but a car already running wide of B (the line hugging
    // the edge) is not pulled in either: no threat leaves the nudge at zero.
    want = clamp(want, Math.min(0, -B - car.lateral + this.nudge), Math.max(0, B - car.lateral + this.nudge));
    this.nudge += clamp(want - this.nudge, -rate * dt, rate * dt);
    if (!near.some((r) => Math.abs(r.fwd) < LEN + 2)) this.nudge *= Math.exp(-1.5 * dt);
  }

  /** Rival position in our body frame: lon forward, lat right. */
  body(car, r) {
    const dx = r.x - car.x, dz = r.z - car.z, sh = Math.sin(car.yaw), ch = Math.cos(car.yaw);
    return { lon: dx * sh + dz * ch, lat: dx * ch - dz * sh };
  }

  /** Station index for a track distance (via the base line's track coordinates). */
  stationOfS(s) {
    const line = this.d.line, L = line.track.length;
    if (!this.sIndex) {
      this.sIndex = new Int32Array(Math.ceil(L)); let j = 0;
      const order = Array.from({ length: line.N }, (_, k) => k).sort((a, b) => line.st[a] - line.st[b]);
      for (let m = 0; m < this.sIndex.length; m++) { while (j < order.length - 1 && line.st[order[j + 1]] <= m) j++; this.sIndex[m] = order[j]; }
    }
    return this.sIndex[Math.floor(((s % L) + L) % L) % this.sIndex.length];
  }

  /** Speed cap from any car ahead in our lane: hold a speed-dependent gap. */
  guard(car, near, i) {
    const d = this.d, path = this.lane ?? d.line;
    let cap = this.reflexCap ?? Infinity;
    for (const r of near) {
      if (r.fwd <= 0 || r.fwd > 90) continue;
      const q = path.closest(r.x, r.z, path.idx(i + Math.round(r.fwd / path.ds) - 8), 30);
      // In the pit the lane is not the path driven: only the bodies say who is in the way.
      const sep = this.pit ? Math.abs(this.body(car, r).lat) : Math.min(Math.abs(q.e), Math.abs(this.body(car, r).lat));
      // Closing fast, more clearance: a slower car ahead may still turn across us.
      const margin = r.fwd < LEN + 2 ? WID - 0.1 : WID + 0.5 + 0.06 * Math.max(0, car.speed - r.speed);
      // A car the guard is already braking for stays guarded for a second: a slow car
      // turning across us must not drop out of the guard just as the gap closes.
      // A car overlapping us and clear beside us is not followed (that would hand it the place).
      const held = this.guardMem?.id === r.id && this.t < this.guardMem.until && r.fwd > LEN + 1;
      // Beside our path now but onto it further on (its learnt line, else ours): a slower car
      // we would reach while it is there is guarded already, before the paths meet.
      const at = (x) => this.d.line.idx(Math.round(this.stationOfS(r.s + x)));
      const vAt = (x) => { const v = this.rivals.profV(r, r.s + x); return Number.isFinite(v) ? v : this.d.line.v[at(x)]; };
      let converging = false;
      if (!this.pit && r.id !== this.blocker && !held && sep > margin && r.fwd > LEN + 1) {
        for (let x = 10; x <= 100 && !converging; x += 10) {
          const vx = vAt(x);
          if (vx > car.speed - 1 || (r.fwd + x) / car.speed > x / Math.max(5, 0.5 * (r.speed + vx)) + 1.5) continue;
          const pl = this.rivals.profLat(r, r.s + x), lat = Number.isFinite(pl) ? pl : this.d.line.lat[at(x)];
          converging = Math.abs(path.lat[at(x)] - lat) < WID + 0.5;
        }
      }
      if (r.id !== this.blocker && !held && sep > margin && !converging) continue;
      // Drafting a same-class car on a straight: close up into the tow (the stop cap below keeps it safe).
      const gap = r.fwd - LEN, want = this.draft ? 0.8 + 0.015 * car.speed : (this.followA ?? 1.5) + (this.followB ?? 0.05) * car.speed;
      const vNext = this.rivals.profV(r, r.s + r.speed * 0.6);
      const vr = Math.min(r.speed, Number.isFinite(vNext) ? vNext + 2 : r.speed);
      // Never close faster than we could stop in the gap that is left.
      const room = Math.max(0, gap - 1.5), vStop = Math.sqrt(Math.max(0, vr * vr + 2 * d.model.brake(car.speed) * 0.7 * room));
      // Too close drops back gently (the tow's gap is shorter than the braking one, and slamming
      // the brakes in a fast kink loses the car); only the stopping distance may demand more.
      let c = Math.min(vr + (this.draft ? 0.7 : 0.45) * Math.max(gap - want, -4), vStop);
      // Its learnt braking further on: it may brake where our line is flat out through a
      // kink, so lift early enough to match it on the grip the corners in between leave.
      for (let x = 10; x <= 150; x += 10) {
        const pv = vAt(x);
        if (!Number.isFinite(pv) || pv >= car.speed) continue;
        const dist = gap - want + x, n = Math.max(1, Math.round(dist / path.ds));
        // The braking left after cornering, averaged over the way there at the speeds driven
        // there (a hairpin at the far end does not take the grip of the straight before it).
        let g = 0, m = 0;
        for (let k = 0; k <= n; k += 2) { const j = path.idx(i + k), vj = Math.min(car.speed, path.v[j]), u = Math.abs(path.ks[j]) * vj * vj / d.model.lat(vj); g += Math.sqrt(Math.max(0.1, 1 - Math.min(1, u) ** 2)); m++; }
        const aB = d.model.brake(car.speed) * (g / m) * 0.9;
        c = Math.min(c, Math.sqrt(pv * pv + 2 * aB * Math.max(0, dist)));
      }
      if (c < car.speed - 2) this.guardMem = { id: r.id, until: this.t + 1 };
      cap = Math.min(cap, c);
    }
    this.cap = cap;
    return cap;
  }
}
