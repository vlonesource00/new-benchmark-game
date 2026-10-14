// SLIPSTREAM world: one real EnduranceRace with learner seats, plus everything the
// learner needs around it — command delivery with game-like reply latency,
// observations, rewards on the game's own rules, and episode resets.
// Nothing here drives the car: learner controls come only from the policy.
import { createRaceEnv, FIXED_DT } from './race-env.mjs';
import { observe, roadTable, OBS, EGO_F, ROAD_K, ROAD_F, RIVAL_N, RIVAL_F } from './observe.mjs';
export { OBS, EGO_F, ROAD_K, ROAD_F, RIVAL_N, RIVAL_F };

const TAU = Math.PI * 2;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// decide: 1 when the seat is free, i.e. the browser would query the NN on this state and the next action is delivered.
// While a reply is in flight the browser never sees the state, so the learner must not step its memory or train on it.
export const TAIL = 5; // reward, done, truncated, first, decide
export const ROW = OBS + TAIL;

/** Safe-ish speed from the sharpest smoothed curvature ahead: only used to pick plausible reset speeds. */
function resetSpeed(road, s, grip = 13) {
  let kmax = 1e-3; for (let d = 0; d < 120; d += 3) kmax = Math.max(kmax, Math.abs(road.k[Math.floor(s + d) % road.n]));
  return Math.min(62, Math.sqrt(grip / kmax));
}

export class World {
  /**
   * cfg: { track, weather, seed, learners, ai: [ids], latency: { min, max, longP, longMin, longMax },
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
    this.failures ??= [];
    for (const a of this.agents) this.resetAgent(a, true);
  }

  // ---- episodes ---------------------------------------------------------------------------------
  resetAgent(a, initial = false) {
    const { car, entry } = a, race = this.env.race, rng = this.rng, cfg = this.cfg, L = this.track.length;
    const starts = cfg.starts ?? { snapshot: 0.4, standing: 0.15 };
    const clear = (s) => race.cars.every((o) => o === car || Math.abs(wrapPi(((o.s - s) / L) * TAU)) * L / TAU > 70);
    // Failure-weighted starts: a share of resets begin 40-200 m before places where episodes recently ended,
    // so rare hard sections (fast flicks, the harbor centreline kink) are practised as often as they are failed.
    const pick = rng(), fromFail = !initial && this.failures.length > 4 && pick >= (starts.snapshot ?? 0) && pick < (starts.snapshot ?? 0) + (starts.failure ?? 0);
    let s = 0, tries = 0;
    // starts.at (evaluation / failure tracing): a fixed place, optionally spread +-starts.spread metres.
    do { s = starts.at != null ? starts.at + (rng() * 2 - 1) * (starts.spread ?? 0) : fromFail ? this.failures[Math.floor(rng() * this.failures.length)] - 40 - rng() * 160 : rng() * L; s = ((s % L) + L) % L; } while (!clear(s) && ++tries < 50);
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
      car.fuel = cfg.fuel ?? (25 + rng() * 45); // evaluations fix it; training draws it (rng untouched when fixed)
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
    // Each episode starts with a clean steward record (incident points, unserved drive-throughs, black flag);
    // the incidents the stewards award during the episode are priced into the reward instead.
    entry.retired = null; car.race.dq = false; car.race.finishTime = null;
    const st = race.stewards?.of(entry);
    if (st) Object.assign(st, { inc: 0, window: { until: -1, max: 0 }, off: false, spun: false, clean: 0, damage: car.damage, penalties: [], issued: 0, dq: false });
    a.inc = 0;
    // The lap in progress spans a teleport: the game must not count it (its validity flag is what scores laps).
    car.race.valid = false; car.race.secValid = false;
    a.lapSeen = car.race.lap; a.offPrev = car.race.offtrack ?? 0;
    a.prevS = car.s; a.dmg0 = car.damage; a.prevDmg = car.damage; a.t = 0;
    a.horizon = (cfg.episode?.min ?? 60) + rng() * ((cfg.episode?.max ?? 120) - (cfg.episode?.min ?? 60));
    a.offFor = 0; a.wasLegal = true; a.slowFor = 0; a.backFor = 0; a.dist = 0; a.legalDist = 0;
    a.illegalSubs = 0; a.offEnters = 0;
    a.applied = [0, 0]; a.appliedAge = 0; a.inflight = null; a.sent = [0, 0]; a.pending = 0;
    a.first = 1; a.end = 0;
  }

  // ---- command delivery -------------------------------------------------------------------------
  /**
   * The browser seat protocol (core/async-seats.js): one request in flight per seat; the car holds the last
   * controls it received. A decision made while a reply is still in flight is never delivered (the seat
   * was busy and not given that state), so at most one reply is outstanding and replies never reorder.
   */
  send(a, steer, pedal, now) {
    if (!Number.isFinite(steer) || !Number.isFinite(pedal)) { a.bad = (a.bad ?? 0) + 1; return; } // hold last controls
    if (a.inflight) { a.busy = (a.busy ?? 0) + 1; return; }
    steer = clamp(steer, -1, 1); pedal = clamp(pedal, -1, 1); a.sent = [steer, pedal];
    const L = this.cfg.latency ?? {}, rng = this.rng;
    const sub = rng() < (L.longP ?? 0.03) ? (L.longMin ?? 8) + Math.floor(rng() * ((L.longMax ?? 30) - (L.longMin ?? 8) + 1))
      : (L.min ?? 1) + Math.floor(rng() * ((L.max ?? 6) - (L.min ?? 1) + 1));
    a.inflight = { at: now + sub, steer, pedal }; a.pending = 1;
  }

  applyArrivals(a, sub) {
    if (a.inflight && a.inflight.at <= sub) { a.applied = [a.inflight.steer, a.inflight.pedal]; a.appliedAge = 0; a.inflight = null; a.pending = 0; }
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
      for (const a of this.agents) {
        a.appliedAge += FIXED_DT; const e = a.entry;
        if (e.pit || e.pitPlan) { e.pit = null; e.pitPlan = null; a.car.race.pitLap = false; }
        // Track limits exactly as the game judges them: its timing adds 1/120 s to `offtrack` on every illegal physics tick.
        const off = a.car.race.offtrack ?? 0, illegal = off > a.offPrev; a.offPrev = off;
        if (illegal) { a.illegalSubs++; if (a.wasLegal) a.offEnters++; }
        a.wasLegal = !illegal;
      }
    }
    const dt = FIXED_DT * substeps;
    // Recycle the race well before anyone's fuel, tyres or the race distance run out: every episode in it is truncated here.
    const recycle = race.time > (this.cfg.lifetime ?? 900) || race.phase !== 'racing';
    for (const a of this.agents) {
      const row = out.subarray(a.k * ROW, (a.k + 1) * ROW);
      if (a.first) { this.observe(a, row); row[OBS] = 0; row[OBS + 1] = 0; row[OBS + 2] = recycle ? 1 : 0; row[OBS + 3] = 1; row[OBS + 4] = a.inflight ? 0 : 1; a.first = 0; a.illegalSubs = a.offEnters = 0; continue; }
      const r = this.reward(a, dt, substeps, stats);
      if (recycle && !r.done && !r.trunc) { r.trunc = true; r.why = 'recycle'; }
      this.observe(a, row);
      row[OBS] = r.reward; row[OBS + 1] = r.done ? 1 : 0; row[OBS + 2] = r.trunc ? 1 : 0; row[OBS + 3] = 0;
      row[OBS + 4] = (r.done || r.trunc || !a.inflight) ? 1 : 0; // a final observation is always consumed (bootstrap value)
      if (r.done || r.trunc) { a.end = 1; stats.episodes++; stats.terminal += r.done ? 1 : 0; stats.why[r.why] = (stats.why[r.why] ?? 0) + 1; }
    }
    if (recycle) this.recycle();
  }

  recycle() {
    this.cfg = { ...this.cfg, seed: (this.cfg.seed * 1103515245 + 12345) >>> 0 };
    const snaps = this.snapshots; this.build(); this.snapshots = snaps;
    // Every episode was truncated on the row just written; the next tick starts new ones and discards its actions.
    for (const a of this.agents) a.end = 1;
  }

  // ---- reward (game rules) ------------------------------------------------------------------------
  reward(a, dt, substeps, stats) {
    const c = a.car, L = this.track.length, R = this.cfg.reward ?? {};
    a.t += dt;
    const ds = wrapPi(((c.s - a.prevS) / L) * TAU) * L / TAU; a.prevS = c.s;
    // Legality from every physics tick of this decision (game rule, see tick()); progress counts only on legal ticks.
    const illegalFrac = a.illegalSubs / substeps, enters = a.offEnters; a.illegalSubs = 0; a.offEnters = 0;
    const legal = illegalFrac === 0;
    const dDmg = Math.max(0, c.damage - a.prevDmg); a.prevDmg = c.damage;
    let reward = ds * (R.progress ?? 0.05) * (1 - illegalFrac) - illegalFrac * (R.offTick ?? 0.1) - enters * (R.offEnter ?? 1);
    reward -= dDmg * (R.damage ?? 40);
    // Incident points as the game's stewards award them (off track 1x, loss of control / wall 2x, heavy contact 4x).
    const inc = this.env.race.stewards?.of(a.entry)?.inc ?? 0, dInc = Math.max(0, inc - a.inc); a.inc = inc;
    reward -= dInc * (R.incident ?? 0.5);
    if (dInc) stats.incidents = (stats.incidents ?? 0) + dInc;
    a.dist += ds; if (legal) a.legalDist += ds;
    a.offFor = illegalFrac === 1 ? a.offFor + dt : 0;
    a.slowFor = c.speed < 2 ? a.slowFor + dt : 0;
    const head = this.road.h[Math.floor(((c.s % L) + L) % L) % this.road.n];
    a.backFor = Math.cos(wrapPi(c.yaw - head)) < 0 ? a.backFor + dt : 0;
    // Laps are scored only as the game scores them: its timing's lap verdict (purple/green/yellow = clean).
    if (c.race.lap !== a.lapSeen) {
      a.lapSeen = c.race.lap;
      const clean = ['purple', 'green', 'yellow'].includes(c.race.lastState);
      if (clean) stats.lap(this.track.id, c.race.lastLap);
      // Per-agent lap verdicts (evaluations): [agent, tick, clean, lap time, game state].
      stats.lapEv?.push([(stats.base ?? 0) + a.k, stats.tick ?? 0, clean ? 1 : 0, +(c.race.lastLap ?? 0).toFixed(3), c.race.lastState ?? null]);
    }
    // Reached states worth restarting from: legal, moving, intact.
    if (legal && c.speed > 8 && c.damage - a.dmg0 < 0.05 && this.rng() < 0.01) {
      const snap = {}; for (const key in c) if (!['spec', 'id', 'name', 'color', 'team', 'race', 'controls'].includes(key) && typeof c[key] !== 'function') snap[key] = c[key];
      this.snapshots.push(structuredClone(snap)); if (this.snapshots.length > 512) this.snapshots.splice(Math.floor(this.rng() * 512), 1);
    }
    stats.ticks++; stats.dist += ds; stats.legal += legal ? 1 : 0; stats.speed += c.speed;
    let done = false, why = null;
    if (a.entry.retired) { done = true; why = 'dq'; }
    else if (c.damage - a.dmg0 > (R.maxDamage ?? 0.25)) { done = true; why = 'damage'; }
    else if (a.offFor > 2) { done = true; why = 'offtrack'; }
    else if (a.backFor > 1.5) { done = true; why = 'backwards'; }
    else if (a.slowFor > 4 && a.t > 6) { done = true; why = 'stuck'; }
    if (done) reward -= R.terminal ?? 3;
    if (done && why !== 'dq') { this.failures.push(c.s); if (this.failures.length > 128) this.failures.shift(); }
    if (done) stats.endEv?.push([(stats.base ?? 0) + a.k, stats.tick ?? 0, why, Math.round(c.s)]);
    if (done && stats.wrecks && stats.wrecks.length < 64) stats.wrecks.push([this.track.id, Math.round(c.s), why, +c.speed.toFixed(1), +c.lateral.toFixed(1)]);
    const trunc = !done && a.t >= a.horizon;
    return { reward, done, trunc, why: why ?? (trunc ? 'horizon' : null) };
  }

  // ---- replay recording (viewer) -------------------------------------------------------------------
  /** Static track geometry for the viewer: centreline every 2 m plus widths. */
  geometry() {
    const r = this.road, pts = [];
    for (let i = 0; i < r.n; i += 2) pts.push([+r.x[i].toFixed(2), +r.z[i].toFixed(2), +r.h[i].toFixed(4), +r.k[i].toFixed(5)]);
    return { id: this.track.id, length: this.track.length, halfWidth: this.track.halfWidth, curbWidth: this.track.curbWidth ?? 0,
      runoffWidth: this.track.runoffWidth ?? 0, finishS: this.track.finishS ?? 0, centre: pts };
  }

  /** One frame of every car: [x, z, yaw, speed, steer, throttle, brake, s, lateral, damage, offtrack, inc, ghost]. */
  frame() {
    const race = this.env.race;
    return {
      t: +race.time.toFixed(3),
      cars: race.cars.map((c) => {
        const e = race.entries[c.id];
        return [+c.x.toFixed(2), +c.z.toFixed(2), +c.yaw.toFixed(4), +c.speed.toFixed(2), +(c.controls.steer ?? 0).toFixed(3), +(c.controls.throttle ?? 0).toFixed(3),
          +(c.controls.brake ?? 0).toFixed(3), +c.s.toFixed(1), +c.lateral.toFixed(2), +c.damage.toFixed(4), +(c.race.offtrack ?? 0).toFixed(3),
          race.stewards?.of(e)?.inc ?? 0, c.ghost ? 1 : 0];
      }),
      agents: this.agents.map((a) => [a.ci, +a.sent[0].toFixed(3), +a.sent[1].toFixed(3), a.pending, +a.appliedAge.toFixed(3), a.end ? 1 : 0]),
    };
  }

  // ---- observation ----------------------------------------------------------------------------------
  observe(a, o) {
    observe(o, { car: a.car, road: this.road, track: this.track, limit: this.limit, cars: this.env.race.cars, learnerIds: this.env.learners, iface: a });
  }
}
