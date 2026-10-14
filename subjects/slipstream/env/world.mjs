// SLIPSTREAM world: one real EnduranceRace with learner seats, plus everything the
// learner needs around it — command delivery with game-like reply latency,
// observations, rewards on the game's own rules, and episode resets.
// Nothing here drives the car: learner controls come only from the policy.
import { createRaceEnv, FIXED_DT } from './race-env.mjs';
import { halfCarInside } from '../../../game/engine/sim/racecraft-policy.js';

const TAU = Math.PI * 2;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// Observation layout (shared with the learner through the worker handshake).
export const ROAD_K = 24, ROAD_F = 6, RIVAL_N = 8, RIVAL_F = 13, EGO_F = 48;
export const OBS = EGO_F + ROAD_K * ROAD_F + RIVAL_N * RIVAL_F;
export const TAIL = 4; // reward, done, truncated, first
export const ROW = OBS + TAIL;
const RIVAL_RANGE = 160;

/** 1 m centreline table so observations never call track.at per sample. */
function roadTable(track) {
  const n = Math.ceil(track.length), x = new Float32Array(n), z = new Float32Array(n), h = new Float32Array(n), k = new Float32Array(n), node = new Int32Array(n);
  for (let i = 0; i < n; i++) { const p = track.at(i); x[i] = p.x; z[i] = p.z; h[i] = p.heading; k[i] = p.curvature; node[i] = p.index; }
  // Curvature smoothed over ±6 m: the node curvature is a 3-point estimate and noisy.
  const ks = new Float32Array(n);
  for (let i = 0; i < n; i++) { let a = 0; for (let d = -6; d <= 6; d++) a += k[(i + d + n) % n]; ks[i] = a / 13; }
  return { n, x, z, h, k: ks, node };
}

/** Safe-ish speed from the sharpest smoothed curvature ahead: only used to pick plausible reset speeds. */
function resetSpeed(road, s, grip = 13) {
  let kmax = 1e-3; for (let d = 0; d < 120; d += 3) kmax = Math.max(kmax, Math.abs(road.k[Math.floor(s + d) % road.n]));
  return Math.min(62, Math.sqrt(grip / kmax));
}

export class World {
  /**
   * cfg: { track, weather, seed, learners, ai: [ids], latency: { min, max, longP, longMin, longMax, dropP },
   *        episode: { min, max }, starts: { snapshot, standing }, lifetime }
   */
  constructor(cfg, rng) {
    this.cfg = cfg; this.rng = rng;
    this.build();
  }

  build() {
    const cfg = this.cfg, seats = [];
    for (let i = 0; i < cfg.learners; i++) seats.push({ learner: true });
    for (const id of cfg.ai ?? []) seats.push({ ai: id });
    this.env = createRaceEnv({ track: cfg.track, seats, seed: cfg.seed, weather: cfg.weather ?? 'clear', classId: cfg.classId ?? 'gt' });
    const race = this.env.race;
    // Skip the lights: the field starts racing from its grid slots and learners are placed by their episodes.
    race.countdown = 0; race.phase = 'racing'; race.primeSeats();
    this.track = this.env.track; this.road = this.roadCache ?? (this.roadCache = roadTable(this.track));
    this.limit = this.track.halfWidth + (this.track.curbWidth ?? 0);
    this.agents = this.env.learners.map((ci, k) => ({ ci, k, car: race.cars[ci], entry: race.entries[ci] }));
    this.snapshots ??= [];
    for (const a of this.agents) this.resetAgent(a, true);
  }

  // ---- episodes ---------------------------------------------------------------------------------
  resetAgent(a, initial = false) {
    const { car, entry } = a, race = this.env.race, rng = this.rng, cfg = this.cfg, L = this.track.length;
    const starts = cfg.starts ?? { snapshot: 0.4, standing: 0.15 };
    const clear = (s) => race.cars.every((o) => o === car || Math.abs(wrapPi(((o.s - s) / L) * TAU)) * L / TAU > 70);
    let s = 0, tries = 0;
    do { s = rng() * L; } while (!clear(s) && ++tries < 50);
    const pick = rng();
    const snap = !initial && this.snapshots.length > 8 && pick < starts.snapshot ? this.snapshots[Math.floor(rng() * this.snapshots.length)] : null;
    if (snap && clear(snap.s)) {
      // A state the policy actually reached earlier (speed, slip, tyre temps, wear), replayed elsewhere in time.
      Object.assign(car, structuredClone(snap));
    } else {
      const standing = pick > 1 - starts.standing;
      const lat = (rng() * 2 - 1) * this.track.halfWidth * 0.7;
      const v = standing ? 0 : resetSpeed(this.road, s) * (0.35 + 0.6 * rng());
      car.place(this.track, s, lat, v);
      race.fitTyres(car, 'medium', true);
      car.fuel = 25 + rng() * 45;
      // Mild perturbation of a feasible state: heading and sideslip within what a driven car shows.
      const dy = (rng() * 2 - 1) * 0.08, beta = (rng() * 2 - 1) * 0.04;
      car.yaw += dy;
      const sp = car.speed, hv = car.yaw + beta;
      car.vx = Math.sin(hv) * sp; car.vz = Math.cos(hv) * sp;
      car.u = sp * Math.cos(beta); car.v = sp * Math.sin(beta) * -1;
    }
    car.controls = { throttle: 0, brake: 0, steer: 0 };
    car.race.previousS = car.s;
    entry.stuckTime = 0; entry.pit = null; entry.pitPlan = null; entry.rescueGhost = 0;
    a.prevS = car.s; a.dmg0 = car.damage; a.prevDmg = car.damage; a.t = 0;
    a.horizon = (cfg.episode?.min ?? 60) + rng() * ((cfg.episode?.max ?? 120) - (cfg.episode?.min ?? 60));
    a.offFor = 0; a.wasLegal = true; a.slowFor = 0; a.backFor = 0; a.dist = 0; a.legalDist = 0;
    a.applied = [0, 0]; a.appliedAge = 0; a.queue = []; a.sent = [0, 0]; a.pending = 0;
    a.lap = { from: null, clean: true }; a.first = 1; a.end = 0;
  }

  // ---- command delivery -------------------------------------------------------------------------
  /** Queue the policy's reply: it lands after a game-like delay, sometimes late, occasionally never. */
  send(a, steer, pedal, now) {
    if (!Number.isFinite(steer) || !Number.isFinite(pedal)) { a.bad = (a.bad ?? 0) + 1; return; } // hold last controls
    steer = clamp(steer, -1, 1); pedal = clamp(pedal, -1, 1); a.sent = [steer, pedal];
    const L = this.cfg.latency ?? {}, rng = this.rng;
    if (rng() < (L.dropP ?? 0.01)) { a.pending = 0; return; }
    const sub = rng() < (L.longP ?? 0.03) ? (L.longMin ?? 8) + Math.floor(rng() * ((L.longMax ?? 30) - (L.longMin ?? 8) + 1))
      : (L.min ?? 1) + Math.floor(rng() * ((L.max ?? 6) - (L.min ?? 1) + 1));
    a.queue.push({ at: now + sub, steer, pedal }); a.pending = 1;
  }

  applyArrivals(a, sub) {
    let landed = null;
    while (a.queue.length && a.queue[0].at <= sub) landed = a.queue.shift();
    if (landed) { a.applied = [landed.steer, landed.pedal]; a.appliedAge = 0; if (!a.queue.length) a.pending = 0; }
    const [st, pd] = a.applied;
    this.env.actions[a.k * 2] = st; this.env.actions[a.k * 2 + 1] = pd;
  }

  // ---- stepping -----------------------------------------------------------------------------------
  /** actions: Float32Array view (2 per agent). out: Float32Array view (ROW per agent). */
  tick(actions, out, substeps, stats) {
    const race = this.env.race;
    // Agents whose episode ended last tick restart now; their action for this tick is discarded.
    for (const a of this.agents) {
      if (a.end) { this.resetAgent(a); continue; }
      this.send(a, actions[a.k * 2], actions[a.k * 2 + 1], this.sub ?? 0);
    }
    for (let i = 0; i < substeps; i++) {
      this.sub = (this.sub ?? 0) + 1;
      for (const a of this.agents) this.applyArrivals(a, this.sub);
      race.step(FIXED_DT);
      for (const a of this.agents) { a.appliedAge += FIXED_DT; const e = a.entry; if (e.pit || e.pitPlan) { e.pit = null; e.pitPlan = null; a.car.race.pitLap = false; } }
    }
    const dt = FIXED_DT * substeps;
    for (const a of this.agents) {
      const row = out.subarray(a.k * ROW, (a.k + 1) * ROW);
      if (a.first) { this.observe(a, row); row[OBS] = 0; row[OBS + 1] = 0; row[OBS + 2] = 0; row[OBS + 3] = 1; a.first = 0; continue; }
      const r = this.reward(a, dt, stats);
      this.observe(a, row);
      row[OBS] = r.reward; row[OBS + 1] = r.done ? 1 : 0; row[OBS + 2] = r.trunc ? 1 : 0; row[OBS + 3] = 0;
      if (r.done || r.trunc) { a.end = 1; stats.episodes++; stats.terminal += r.done ? 1 : 0; stats.why[r.why] = (stats.why[r.why] ?? 0) + 1; }
    }
    // Recycle the race well before anyone's fuel, tyres or the race distance run out.
    if (race.time > (this.cfg.lifetime ?? 900) || race.phase !== 'racing') this.recycle();
  }

  recycle() {
    this.cfg = { ...this.cfg, seed: (this.cfg.seed * 1103515245 + 12345) >>> 0 };
    const snaps = this.snapshots; this.build(); this.snapshots = snaps;
    for (const a of this.agents) a.end = 0;
  }

  // ---- reward (game rules) ------------------------------------------------------------------------
  reward(a, dt, stats) {
    const c = a.car, L = this.track.length, R = this.cfg.reward ?? {};
    a.t += dt;
    const ds = wrapPi(((c.s - a.prevS) / L) * TAU) * L / TAU; a.prevS = c.s;
    // The game's track-limit rule (core/race.js timing): inner wheels' contact patch beyond the kerb's outer edge.
    const legal = halfCarInside(Math.abs(c.lateral) - (c.spec?.track ?? 1.72) / 2, this.limit);
    const dDmg = Math.max(0, c.damage - a.prevDmg); a.prevDmg = c.damage;
    let reward = 0;
    if (legal) reward += ds * (R.progress ?? 0.05); else { reward -= R.offTick ?? 0.1; if (a.wasLegal) reward -= R.offEnter ?? 1; }
    reward -= dDmg * (R.damage ?? 40);
    a.dist += ds; if (legal) a.legalDist += ds;
    a.wasLegal = legal; a.offFor = legal ? 0 : a.offFor + dt;
    a.slowFor = c.speed < 2 ? a.slowFor + dt : 0;
    const head = this.road.h[Math.floor(((c.s % L) + L) % L) % this.road.n];
    a.backFor = Math.cos(wrapPi(c.yaw - head)) < 0 ? a.backFor + dt : 0;
    // Lap timing on the learner's own line crossing, for the scoreboard only.
    const fin = this.track.finishS ?? 0, crossed = ds > 0 && wrapPi(((c.s - fin) / L) * TAU) >= 0 && wrapPi(((c.s - ds - fin) / L) * TAU) < 0;
    if (!legal) a.lap.clean = false;
    if (crossed) {
      if (a.lap.from !== null && a.lap.clean) stats.lap(this.track.id, this.env.race.time - a.lap.from);
      a.lap = { from: this.env.race.time, clean: true };
    }
    // Reached states worth restarting from: legal, moving, intact.
    if (legal && c.speed > 8 && c.damage - a.dmg0 < 0.05 && this.rng() < 0.01) {
      const snap = {}; for (const key in c) if (!['spec', 'id', 'name', 'color', 'team', 'race', 'controls'].includes(key) && typeof c[key] !== 'function') snap[key] = c[key];
      this.snapshots.push(structuredClone(snap)); if (this.snapshots.length > 512) this.snapshots.splice(Math.floor(this.rng() * 512), 1);
    }
    stats.ticks++; stats.dist += ds; stats.legal += legal ? 1 : 0; stats.speed += c.speed;
    let done = false, why = null;
    if (c.damage - a.dmg0 > (R.maxDamage ?? 0.25)) { done = true; why = 'damage'; }
    else if (a.offFor > 2) { done = true; why = 'offtrack'; }
    else if (a.backFor > 1.5) { done = true; why = 'backwards'; }
    else if (a.slowFor > 4 && a.t > 6) { done = true; why = 'stuck'; }
    if (done) reward -= R.terminal ?? 3;
    const trunc = !done && a.t >= a.horizon;
    return { reward, done, trunc, why: why ?? (trunc ? 'horizon' : null) };
  }

  // ---- observation ----------------------------------------------------------------------------------
  observe(a, o) {
    const c = a.car, road = this.road, L = this.track.length, n = road.n, trk = this.track;
    const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
    // Ego frame: forward = (sin yaw, cos yaw), right-hand lateral = (cos yaw, -sin yaw).
    const fwd = (dx, dz) => dx * sy + dz * cy, lat = (dx, dz) => dx * cy - dz * sy;
    const si = Math.floor(((c.s % L) + L) % L) % n, head = road.h[si];
    let j = 0; const put = (v) => { o[j++] = Number.isFinite(v) ? v : 0; };
    // Ego dynamics and the interface state (what was actually applied and how stale it is).
    put(c.u / 50); put(c.v / 10); put(c.yawRate / 2); put(c.ax / 20); put(c.ay / 20); put(c.speed / 50);
    put(c.steering / (c.spec?.steeringLock ?? 0.5)); put(c.gear / 7); put(c.rpm / 9000);
    put(a.applied[0]); put(a.applied[1]); put(clamp(a.appliedAge * 5, 0, 3)); put(a.sent[0]); put(a.sent[1]); put(a.pending);
    put(c.lateral / trk.halfWidth); put((this.limit - (Math.abs(c.lateral) - (c.spec?.track ?? 1.72) / 2)) / 3);
    const he = wrapPi(c.yaw - head); put(Math.sin(he)); put(Math.cos(he));
    put(trk.halfWidth / 8); put((trk.curbWidth ?? 0) / 3);
    put(c.damage * 4); put(c.fuel / 80);
    for (const w of c.wheels) { const t = w.tyre; put(t.kappa ?? 0); put((t.alpha ?? 0) * 4); put(w.load / 6000); put((t.core - (t.optimum ?? 85)) / 30); put(t.wear * 2); }
    const zone = c.zone; put(zone === 'kerb' ? 1 : 0); put(zone === 'gravel' || zone === 'grass' ? 1 : 0);
    put(trk.wetness ?? 0); put((trk.tempGrip ?? 1) - 1);
    put(c.aero?.wake ?? 0); put(c.hybrid ? (c.hybrid.soc ?? 0) : 0);
    while (j < EGO_F) put(0);
    // Road ahead: centreline samples, denser near the car, reaching further with speed.
    const reach = 60 + 4.2 * Math.max(0, c.speed), water = trk.water;
    for (let i = 0; i < ROAD_K; i++) {
      const d = reach * ((i + 1) / ROAD_K) ** 1.6, q = Math.floor(c.s + d) % n, qi = (q + n) % n;
      const dx = road.x[qi] - c.x, dz = road.z[qi] - c.z, rh = wrapPi(road.h[qi] - c.yaw);
      let wet = 0;
      if (water?.live) { const b = road.node[qi] * 13; for (let l = 0; l < 13; l++) wet += water.depth[b + l]; wet /= 13; }
      put(fwd(dx, dz) / 100); put(lat(dx, dz) / 20); put(Math.sin(rh)); put(Math.cos(rh)); put(road.k[qi] * 30); put(wet);
    }
    // Rivals: nearest along the lap within range, ego frame.
    const near = [];
    for (const r of this.env.race.cars) {
      if (r === c) continue;
      const g = wrapPi(((r.s - c.s) / L) * TAU) * L / TAU;
      if (Math.abs(g) < RIVAL_RANGE) near.push([Math.abs(g), g, r]);
    }
    near.sort((p, q) => p[0] - q[0]);
    for (let i = 0; i < RIVAL_N; i++) {
      const p = near[i];
      if (!p) { for (let f = 0; f < RIVAL_F; f++) put(0); continue; }
      const [, g, r] = p, dx = r.x - c.x, dz = r.z - c.z, dvx = r.vx - c.vx, dvz = r.vz - c.vz, ry = wrapPi(r.yaw - c.yaw);
      put(1); put(fwd(dx, dz) / 50); put(lat(dx, dz) / 10); put(fwd(dvx, dvz) / 20); put(lat(dvx, dvz) / 10);
      put(Math.sin(ry)); put(Math.cos(ry)); put(g / 100); put(r.lateral / trk.halfWidth); put(r.speed / 50);
      put(r.damage * 4); put(r.ghost ? 1 : 0); put(this.env.learners.includes(r.id) ? 1 : 0);
    }
  }
}
