// SLIPSTREAM world: one real EnduranceRace with learner seats, plus everything the
// learner needs around it — command delivery with game-like reply latency,
// observations, rewards on the game's own rules, and episode resets.
// Nothing here drives the car: learner controls come only from the policy.
import { createRaceEnv, FIXED_DT } from './race-env.mjs';
import { observe, roadTable, OBS, EGO_F, ROAD_K, ROAD_F, RIVAL_N, RIVAL_F, EGO_X, RIVAL_X } from './observe.mjs';
export { OBS, EGO_F, ROAD_K, ROAD_F, RIVAL_N, RIVAL_F, EGO_X, RIVAL_X };

const TAU = Math.PI * 2;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
// Safety-cost reward terms (the row's risk value); the rest (progress, pass, lost, stuck, behind) is the task.
const RISK = new Set(['off', 'damage', 'margin', 'incident', 'rearEnd', 'ttc', 'rub', 'clear', 'terminal']);

// decide: 1 when the seat is free, i.e. the browser would query the NN on this state and the next action is delivered.
// While a reply is in flight the browser never sees the state, so the learner must not step its memory or train on it.
// risk: the part of reward that is a safety cost (RISK terms below), for a critic that values it apart from the task.
export const TAIL = 6; // reward, done, truncated, first, decide, risk
export const ROW = OBS + TAIL;

/** Safe-ish speed from the sharpest smoothed curvature ahead: only used to pick plausible reset speeds. */
function resetSpeed(road, s, grip = 13) {
  let kmax = 1e-3; for (let d = 0; d < 120; d += 3) kmax = Math.max(kmax, Math.abs(road.k[Math.floor(s + d) % road.n]));
  return Math.min(62, Math.sqrt(grip / kmax));
}

/** place() resets a car to first gear, and the gearbox refuses an upshift into over 8100 rpm: a car placed above
 *  ~35 m/s would coast on the limiter in first until it slowed (and from ~25 m/s lose ~0.4 s to a shift chain). Fit
 *  the lowest gear under 7800 rpm at the placed speed, as a car already driving at it would be in. */
function fitGear(c) {
  const S = c.spec, rpm = (g) => c.u / S.radius * S.gears[g] * S.finalDrive * 60 / (2 * Math.PI);
  let g = 1; while (g < S.gears.length - 1 && rpm(g) > 7800) g++;
  c.gear = g; c.rpm = Math.max(1100, rpm(g));
}

export class World {
  /**
   * cfg: { track, weather, seed, learners, ai: [ids], latency: { min, max, longP, longMin, longMax } | { frames: [[substeps, weight]...], extraP, longP, longMin, longMax },
   *        episode: { min, max }, starts: { snapshot, standing }, lifetime }
   */
  constructor(cfg, rng) {
    this.cfg = cfg; this.rng = rng;
    this.build();
  }

  build() {
    const cfg = this.cfg, seats = [];
    for (let i = 0; i < cfg.learners; i++) seats.push({ learner: true });
    // challenge: every build is one short pass challenge against challenge.opp [min, max] rivals drawn from cfg.ai.
    const C = cfg.challenge;
    // An AI entry 'id:class' (e.g. 'intercept:lmdh') races that car class; plain ids race cfg.classId (multiclass fields).
    const aiSeat = (e) => { const [ai, classId] = e.split(':'); return classId ? { ai, classId } : { ai }; };
    if (C) { const n = C.opp[0] + Math.floor(this.rng() * (C.opp[1] - C.opp[0] + 1)); for (let i = 0; i < n; i++) seats.push(aiSeat(cfg.ai[Math.floor(this.rng() * cfg.ai.length)])); }
    else for (const id of cfg.ai ?? []) seats.push(aiSeat(id));
    // gridOrder 'shuffle': grid slots (seat order) drawn per build, so learners start anywhere in the pack.
    if (cfg.gridOrder === 'shuffle') for (let i = seats.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [seats[i], seats[j]] = [seats[j], seats[i]]; }
    // starts.grid: share of builds in which every learner keeps its grid slot and starts standing with the whole field
    // (the race's first lap in a pack). Held until the learners' first episodes begin (see tick).
    this.gridStart = (cfg.starts?.grid ?? 0) > 0 && this.rng() < cfg.starts.grid; // no draw unless configured (seeded tests)
    this.env = createRaceEnv({ track: cfg.track, seats, seed: cfg.seed, weather: cfg.weather ?? 'clear', classId: cfg.classId ?? 'gt' });
    const race = this.env.race;
    // Skip the lights: the field starts racing from its grid slots and learners are placed by their episodes.
    race.countdown = 0; race.phase = 'racing'; race.primeSeats();
    // Contact fault (reward.rearEnd): the physics reports contact pairs with their closing speed to the stewards, who
    // charge both cars alike. Read them before the stewards consume them and keep, per car, the hardest contact this
    // tick in which it was the car behind (less race progress by over 2 m; closer than that is side by side).
    // rub: physics ticks this tick in which the car touched any car at all (reward.rub, side contact included).
    // An impact is the onset of a pair's contact (no contact between them for the previous ONSET physics ticks): a
    // sustained push is one impact plus rubbing, not a rear-end charge on every decision it lasts (which priced a 1 s
    // push at 1 m/s like thirty impacts). reward.rearEveryTick restores the old per-decision charge.
    // nose: physics ticks this tick in contact with a car over 2 m ahead (this car ran into it; reward.dirtyBlame).
    this.rear = new Float32Array(race.cars.length); this.rub = new Float32Array(race.cars.length); this.nose = new Float32Array(race.cars.length);
    const st = race.stewards, ONSET = 30, lastTouch = new Map(), everyTick = cfg.reward?.rearEveryTick;
    let phys = 0;
    if (st) {
      const step = st.step.bind(st);
      st.step = (dt) => {
        phys++;
        const hit = new Set();
        for (const [i, j] of st.pairs) { hit.add(i); hit.add(j); }
        for (const i of hit) this.rub[i]++;
        for (const [i, j, closing] of st.pairs) {
          const key = i < j ? i * 64 + j : j * 64 + i, onset = phys - (lastTouch.get(key) ?? -1e9) > ONSET;
          lastTouch.set(key, phys);
          const d = race.cars[i].race.progress - race.cars[j].race.progress;
          if (Math.abs(d) > 2) this.nose[d < 0 ? i : j]++;
          if (!onset && !everyTick) continue;
          if (Math.abs(d) > 2) { const b = d < 0 ? i : j; this.rear[b] = Math.max(this.rear[b], closing); }
        }
        return step(dt);
      };
    }
    this.track = this.env.track; this.road = this.roadCache ?? (this.roadCache = roadTable(this.track));
    this.limit = this.track.halfWidth + (this.track.curbWidth ?? 0);
    this.agents = this.env.learners.map((ci, k) => ({ ci, k, car: race.cars[ci], entry: race.entries[ci] }));
    if (C) this.placeChallenge();
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
    // Site starts: a further starts.siteP share begins 40-200 m before the places where completion tests fail on this
    // track (starts.sites[track], fed from the tests), so the corners that decide the 3-lap goal are practised even
    // when training's own episodes rarely end there.
    const sites = starts.sites?.[cfg.track], p0 = (starts.snapshot ?? 0) + (starts.failure ?? 0);
    const fromSite = !initial && !fromFail && sites?.length && pick >= p0 && pick < p0 + (starts.siteP ?? 0);
    // starts.siteLead [min, max] metres before the site (default 40-200); a longer lead lets the car reach its own
    // approach speed and line before the corner instead of arriving at the reset speed and lateral draw.
    const lead = starts.siteLead ?? [40, 200];
    if (cfg.challenge) { this.placeLearner(a); return this.beginEpisode(a, false); }
    // Pack starts: a further starts.pack share begins 8-45 m behind or beside another moving car at its speed (+-8%),
    // so close running (draft, braking in a queue, side by side) is practised; plain starts keep 70 m from everyone.
    const p1 = p0 + (starts.siteP ?? 0);
    const fromPack = !initial && !fromFail && !fromSite && pick >= p1 && pick < p1 + (starts.pack ?? 0) && this.packStart(a);
    if (this.gridStart || fromPack) return this.beginEpisode(a, true);
    let s = 0, tries = 0;
    // starts.at (evaluation / failure tracing): a fixed place, optionally spread +-starts.spread metres.
    do { s = starts.at != null ? starts.at + (rng() * 2 - 1) * (starts.spread ?? 0) : fromFail ? this.failures[Math.floor(rng() * this.failures.length)] - 40 - rng() * 160 : fromSite ? sites[Math.floor(rng() * sites.length)] - lead[0] - rng() * (lead[1] - lead[0]) : rng() * L; s = ((s % L) + L) % L; } while (!clear(s) && ++tries < 50);
    const snap = !initial && this.snapshots.length > 8 && pick < starts.snapshot ? this.snapshots[Math.floor(rng() * this.snapshots.length)] : null;
    if (snap && clear(snap.s)) {
      // A state the policy actually reached earlier (speed, slip, tyre temps, wear), replayed elsewhere in time.
      Object.assign(car, structuredClone(snap));
    } else {
      const standing = pick > 1 - starts.standing;
      const lat = (rng() * 2 - 1) * this.track.halfWidth * 0.7;
      const v = standing ? 0 : resetSpeed(this.road, s) * (0.35 + 0.6 * rng());
      car.place(this.track, s, lat, v); fitGear(car);
      race.fitTyres(car, 'medium', true);
      // starts.tyreSnap: share of these starts that take the tyres' thermal state and wear from a reached snapshot, so
      // fail sites are also practised on long-run tyres (fronts cool 8-11 C under optimum), not only freshly fitted ones.
      if (starts.tyreSnap && this.snapshots.length > 8 && rng() < starts.tyreSnap) {
        const sn = this.snapshots[Math.floor(rng() * this.snapshots.length)];
        car.wheels.forEach((w, i) => { const st = sn.wheels?.[i]?.tyre; if (st) for (const k of ['surface', 'core', 'inner', 'outer', 'pressure', 'wear']) w.tyre[k] = st[k]; });
      }
      car.fuel = cfg.fuel ?? (25 + rng() * 45); // evaluations fix it; training draws it (rng untouched when fixed)
      // Mild perturbation of a feasible state: heading and sideslip within what a driven car shows.
      const dy = (rng() * 2 - 1) * 0.08, beta = (rng() * 2 - 1) * 0.04;
      car.yaw += dy;
      const sp = car.speed, hv = car.yaw + beta;
      car.vx = Math.sin(hv) * sp; car.vz = Math.cos(hv) * sp;
      car.u = sp * Math.cos(beta); car.v = sp * Math.sin(beta) * -1;
    }
    this.beginEpisode(a, false);
  }

  /** Places a 8-45 m behind or beside a moving, legal car with 6 m clearance to every car; false if none fits. */
  packStart(a) {
    const { car } = a, race = this.env.race, rng = this.rng, L = this.track.length, hw = this.track.halfWidth;
    const others = race.cars.filter((o) => o !== car && o.speed > 12 && Math.abs(o.lateral) < hw && !race.entries[race.cars.indexOf(o)].retired);
    if (!others.length) return false;
    const gap = (p, q) => { const ds = Math.abs(wrapPi(((p.s - q.s) / L) * TAU)) * L / TAU; return Math.hypot(ds, p.lat - q.lateral); };
    for (let tries = 0; tries < 12; tries++) {
      const o = others[Math.floor(rng() * others.length)];
      const p = { s: (((o.s - 8 - rng() * 37) % L) + L) % L, lat: clamp(o.lateral + (rng() * 2 - 1) * 4, -hw * 0.8, hw * 0.8) };
      if (!race.cars.every((q) => q === car || gap(p, q) > 6)) continue;
      car.place(this.track, p.s, p.lat, o.speed * (0.92 + 0.16 * rng())); fitGear(car);
      return true;
    }
    return false;
  }

  /**
   * Pass challenge (cfg.challenge): the rivals run as a train from a random place on the lap, gapM [min, max] metres
   * apart at a share speed [min, max] of the corner-limited speed there, each on a random compound from compounds with
   * a random wear [min, max] (the cliff starts at 0.72). Race progress follows the lap position, so the order is real.
   */
  placeChallenge() {
    const race = this.env.race, rng = this.rng, C = this.cfg.challenge, L = this.track.length, hw = this.track.halfWidth;
    const draw = (r) => r[0] + rng() * (r[1] - r[0]);
    const rivals = race.cars.filter((c, i) => !this.env.learners.includes(i));
    const s0 = rng() * L; let off = 0;
    this.challengeTail = s0; this.challengeBase = race.cars[0].race.progress;
    for (const c of rivals) { // the rearmost rival first: progress grows along the train
      const s = (s0 + off) % L;
      c.place(this.track, s, (rng() * 2 - 1) * hw * 0.5, resetSpeed(this.road, s) * draw(C.speed ?? [0.6, 0.9])); fitGear(c);
      this.fitDrawn(c);
      c.race.previousS = c.s; c.race.progress = this.challengeBase + off;
      off += draw(C.gapM ?? [15, 45]);
    }
  }

  /**
   * The learner behind the rearmost rival by leadM [min, max] metres, on its own draws (learnerCompounds, learnerWear;
   * default the rivals'). matchSpeed [min, max]: start at that share of the rearmost rival's speed instead of an
   * independent draw. With the AIs at about the learner's pace, a challenge can only be won from a pace advantage (as
   * real passes come from tyre and speed deltas): fresher tyres than the rivals' and no speed deficit at the start.
   */
  placeLearner(a) {
    const { car } = a, race = this.env.race, rng = this.rng, C = this.cfg.challenge, L = this.track.length, hw = this.track.halfWidth;
    const lead = C.leadM ?? [20, 60], back = lead[0] + rng() * (lead[1] - lead[0]), s = (((this.challengeTail - back) % L) + L) % L;
    const tail = race.cars.filter((o) => o !== car).reduce((m, o) => (o.race.progress < m.race.progress ? o : m));
    const v = C.matchSpeed ? Math.min(resetSpeed(this.road, s), tail.speed * (C.matchSpeed[0] + rng() * (C.matchSpeed[1] - C.matchSpeed[0]))) : resetSpeed(this.road, s) * (0.6 + 0.3 * rng());
    car.place(this.track, s, (rng() * 2 - 1) * hw * 0.6, v); fitGear(car);
    this.fitDrawn(car, C.learnerCompounds, C.learnerWear);
    car.fuel = this.cfg.fuel ?? (25 + rng() * 45);
    car.race.previousS = car.s; car.race.progress = this.challengeBase - back;
  }

  fitDrawn(c, compounds, wear) {
    const C = this.cfg.challenge, rng = this.rng, comp = compounds ?? C.compounds ?? ['soft', 'medium', 'hard'];
    this.env.race.fitTyres(c, comp[Math.floor(rng() * comp.length)], true);
    const w = wear ?? C.wear ?? [0, 0.65], x = w[0] + rng() * (w[1] - w[0]);
    c.wheels.forEach((wh) => { wh.tyre.wear = clamp(x + (rng() - 0.5) * 0.04, 0, 1); });
  }

  /** Episode bookkeeping after placement. fresh: grid and pack starts, which skipped the plain start's tyres and fuel. */
  beginEpisode(a, fresh) {
    const { car, entry } = a, race = this.env.race, rng = this.rng, cfg = this.cfg;
    if (fresh) { // fresh medium tyres and drawn fuel, as a plain start
      // starts.gridCold: grid starts on cold tyres (72 C vs 88), as the game's race start fits its start compound.
      race.fitTyres(car, 'medium', !(this.gridStart && cfg.starts?.gridCold));
      car.fuel = cfg.fuel ?? (25 + rng() * 45);
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
    a.lapSeen = car.race.lap; a.offPrev = car.race.offtrack ?? 0; a.cutS = null;
    a.prevS = car.s; a.dmg0 = car.damage; a.prevDmg = car.damage; a.t = 0;
    a.horizon = (cfg.episode?.min ?? 60) + rng() * ((cfg.episode?.max ?? 120) - (cfg.episode?.min ?? 60));
    a.offFor = 0; a.wasLegal = true; a.slowFor = 0; a.backFor = 0; a.dist = 0; a.legalDist = 0;
    a.illegalSubs = 0; a.offEnters = 0;
    a.applied = [0, 0]; a.appliedAge = 0; a.inflight = null; a.sent = [0, 0]; a.pending = 0;
    // Frame model (browser/test-seat.mjs measurements): the game steps physics once per rendered frame and takes worker
    // replies between frames, so a reply lands one frame (sometimes two) after its observation; the frame time is drawn per episode.
    const F = cfg.latency?.frames; if (F) { let u = rng() * F.reduce((t, x) => t + x[1], 0), i = 0; while (u >= F[i][1] && i < F.length - 1) u -= F[i++][1]; a.frame = F[i][0]; }
    a.first = 1; a.end = 0;
    // Pass challenge: per rival, which side of it we are on, since when, and the current pass attempt (see reward).
    // racePass: the same place scoring in ordinary race worlds, against AI rivals of this car's class only (being
    // lapped by a faster class is not a lost place; contact with it is still charged by the traffic costs).
    if (cfg.challenge || cfg.racePass) {
      const L = this.track.length, cls = car.classId ?? 'gt';
      a.opp = race.cars.filter((o) => o !== car && !this.env.learners.includes(o.id) && (cfg.challenge || (o.classId ?? 'gt') === cls))
        .map((o) => ({ c: o, ahead: wrapPi(((o.s - car.s) / L) * TAU) > 0, since: 0, closeAt: null, dirty: false, pend: null }));
      a.cleared = false;
    }
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
      : a.frame ? a.frame * (rng() < (L.extraP ?? 0.05) ? 2 : 1)
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
    this.gridStart = false; // grid starts hold only for the episodes that begin with the build
    this.rear.fill(0); this.rub.fill(0); this.nose.fill(0);
    for (let i = 0; i < substeps; i++) {
      this.sub = (this.sub ?? 0) + 1;
      for (const a of this.agents) this.applyArrivals(a, this.sub);
      race.step(FIXED_DT);
      for (const a of this.agents) {
        a.appliedAge += FIXED_DT; const e = a.entry;
        if (e.pit || e.pitPlan) { e.pit = null; e.pitPlan = null; a.car.race.pitLap = false; }
        // Track limits exactly as the game judges them: its timing adds 1/120 s to `offtrack` on every illegal physics tick.
        const off = a.car.race.offtrack ?? 0, illegal = off > a.offPrev; a.offPrev = off;
        if (illegal) { a.illegalSubs++; if (a.wasLegal) { a.offEnters++; a.cutS ??= Math.round(a.car.s); if (this.cfg.starts?.offSites) this.noteFailure(a.car.s); } }
        a.wasLegal = !illegal;
      }
    }
    const dt = FIXED_DT * substeps;
    // Recycle the race well before anyone's fuel, tyres or the race distance run out: every episode in it is truncated here.
    const recycle = race.time > (this.cfg.lifetime ?? 900) || race.phase !== 'racing';
    for (const a of this.agents) {
      const row = out.subarray(a.k * ROW, (a.k + 1) * ROW);
      if (a.first) { this.observe(a, row); row[OBS] = 0; row[OBS + 1] = 0; row[OBS + 2] = recycle ? 1 : 0; row[OBS + 3] = 1; row[OBS + 4] = a.inflight ? 0 : 1; row[OBS + 5] = 0; a.first = 0; a.illegalSubs = a.offEnters = 0; continue; }
      const r = this.reward(a, dt, substeps, stats);
      if (recycle && !r.done && !r.trunc) { r.trunc = true; r.why = 'recycle'; }
      this.observe(a, row);
      row[OBS] = r.reward; row[OBS + 1] = r.done ? 1 : 0; row[OBS + 2] = r.trunc ? 1 : 0; row[OBS + 3] = 0;
      row[OBS + 4] = (r.done || r.trunc || !a.inflight) ? 1 : 0; // a final observation is always consumed (bootstrap value)
      row[OBS + 5] = r.risk;
      if (r.done || r.trunc) { a.end = 1; stats.episodes++; stats.terminal += r.done ? 1 : 0; stats.why[r.why] = (stats.why[r.why] ?? 0) + 1; }
    }
    // A pass challenge is one episode: when it ends (cleared, timed out or failed) the next build draws a new one.
    if (recycle || (this.cfg.challenge && this.agents.every((a) => a.end))) this.recycle();
  }

  /** Failure starts replay the run-up to places where the learner crashed or (starts.offSites) broke track limits. */
  noteFailure(s) { this.failures.push(s); if (this.failures.length > 128) this.failures.shift(); }

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
    // Reward ledger (stats.ledger): every term's contribution summed per term, so the worker stats show what the reward
    // is made of (the reward itself is the plain sum; the ledger only records it).
    const lg = (stats.ledger ??= {});
    let reward = 0, risk = 0;
    const add = (k, v) => { if (v) { reward += v; lg[k] = (lg[k] ?? 0) + v; if (RISK.has(k)) risk += v; } };
    add('progress', ds * (R.progress ?? 0.05) * (1 - illegalFrac));
    add('off', -illegalFrac * (R.offTick ?? 0.1) - enters * (R.offEnter ?? 1));
    add('damage', -dDmg * (R.damage ?? 40));
    // Near-miss margin (reward.margin per second, default off): a dense cost that grows as the outermost wheel's legal
    // margin (the game's half-car-inside test, as observed) shrinks below marginM metres, so the policy learns where
    // the limit is before it crosses it. A rare crossing penalty alone is a sparse signal: cheap cuts kept winning.
    if (R.margin) {
      const M = R.marginM ?? 0.5, m = this.limit - (Math.abs(c.lateral) - (c.spec?.track ?? 1.72) / 2);
      if (m < M) add('margin', -R.margin * dt * Math.min(1, 1 - m / M));
    }
    // Incident points as the game's stewards award them (off track 1x, loss of control / wall 2x, heavy contact 4x).
    const inc = this.env.race.stewards?.of(a.entry)?.inc ?? 0, dInc = Math.max(0, inc - a.inc); a.inc = inc;
    add('incident', -dInc * (R.incident ?? 0.5));
    if (dInc) stats.incidents = (stats.incidents ?? 0) + dInc;
    // Fault-attributed traffic costs (default off). rearEnd: per m/s of closing speed in a contact where this car was
    // the one behind; being hit is not charged. ttc: a dense cost per second while closing on a car ahead in this car's
    // lane (lateral overlap) with under ttcS seconds to contact, growing as that time shrinks, so the policy learns to
    // lift, brake or change line before the contact the sparse costs only price afterwards.
    if (R.rearEnd && this.rear[a.ci] > 0) { add('rearEnd', -R.rearEnd * this.rear[a.ci]); stats.rearEnds = (stats.rearEnds ?? 0) + 1; }
    if (R.ttc) {
      const T = R.ttcS ?? 1.0, w = (c.spec?.track ?? 1.72) + 0.3;
      let worst = 0;
      for (const r of this.env.race.cars) {
        if (r === c) continue;
        const gap = wrapPi(((r.s - c.s) / L) * TAU) * L / TAU, close = c.speed - r.speed;
        if (gap <= 0 || gap > 60 || close <= 0.5 || Math.abs(r.lateral - c.lateral) > w) continue;
        const t = (gap - 4.6) / close; // 4.6 m: one car length, centre to centre
        if (t < T) worst = Math.max(worst, Math.min(1, 1 - t / T));
      }
      if (worst > 0) { add('ttc', -R.ttc * dt * worst); stats.ttc = (stats.ttc ?? 0) + dt; }
    }
    // rub: per second in contact with any car (closing speed and side irrelevant): leaning on cars to get past is not
    // free. clear: per second alongside a car (within 5 m along the lap) with the centre-to-centre lateral gap under
    // clearM, growing from 0 at clearM to 1 at a car's width, so passes are made with room (using the track's width).
    if (R.rub && this.rub[a.ci] > 0) { const sec = this.rub[a.ci] * FIXED_DT; add('rub', -R.rub * sec); stats.rub = (stats.rub ?? 0) + sec; }
    if (R.clear) {
      const W = 1.96, M = R.clearM ?? 2.6; // W: car width of the collision box (2 x 0.98 m, vehicle.js collisions)
      let worst = 0;
      for (const r of this.env.race.cars) {
        if (r === c) continue;
        const gap = wrapPi(((r.s - c.s) / L) * TAU) * L / TAU, sep = Math.abs(r.lateral - c.lateral);
        if (Math.abs(gap) < 5 && sep < M) worst = Math.max(worst, Math.min(1, (M - sep) / (M - W)));
      }
      if (worst > 0) { add('clear', -R.clear * dt * worst); stats.clear = (stats.clear ?? 0) + dt; }
    }
    // Pass challenge rewards (cfg.challenge). A pass is a rival that stays behind for passHold s; it pays reward.pass,
    // half of it scaled by how quickly the pass followed closing within 1 s (passT s for nothing extra), and nothing
    // when this car touched any car, broke track limits or drew incident points from closing until the pass held.
    // Being passed costs reward.lost (>= pass, so giving a place back to retake it never pays; with passDirty > 0 a
    // dirty pass pays less than that, so the same holds). stuck: per second
    // within 1 s behind a rival; behind: per second per rival still ahead at any distance (the clock of the
    // challenge, so following out of the 1 s window does not escape it). Every rival passed ends the episode.
    if (a.opp) {
      const v = Math.max(c.speed, 10), HOLD = R.passHold ?? 2, T = R.passT ?? 15;
      // dirtyBlame: only this car's own fault makes a pass dirty (running into a car ahead, breaking track limits);
      // being hit, side contact and incident points the stewards charge both cars for keep the pass paid (each is still
      // priced by its own term). Otherwise any contact, off or incident does.
      const dirtyNow = R.dirtyBlame ? this.nose[a.ci] > 0 || illegalFrac > 0 : this.rub[a.ci] > 0 || illegalFrac > 0 || dInc > 0;
      let stuck = false;
      for (const o of a.opp) {
        const g = wrapPi(((o.c.s - c.s) / L) * TAU) * L / TAU, gs = g / v;
        if (gs > 0 && gs < 1) { stuck = true; if (o.closeAt == null) { o.closeAt = a.t; stats.closes = (stats.closes ?? 0) + 1; } } // closes: encounters (passes per close = conversion)
        if (gs > 1.5 && !o.pend) { o.closeAt = null; o.dirty = false; }
        if ((o.closeAt !== null || Math.abs(g) < 10) && dirtyNow && !o.dirty) { // first cause, for the stats
          o.dirty = true; o.why = R.dirtyBlame && this.nose[a.ci] > 0 ? 'nose' : this.rub[a.ci] > 0 && !R.dirtyBlame ? 'rub' : illegalFrac > 0 ? 'off' : 'inc';
        }
        const ahead = g > 0; // sides swap only near the car: a rival half a lap away wrapping across is not a pass
        if (ahead !== o.ahead && Math.abs(g) < 100) { o.ahead = ahead; o.since = a.t; o.pend = ahead ? 'lost' : 'pass'; }
        if (o.pend && a.t - o.since >= HOLD) {
          if (o.pend === 'pass') {
            const took = o.since - (o.closeAt ?? o.since);
            // passDirty: the share still paid when the pass was dirty (its contact, offs and incidents are priced by their
            // own terms; 0 = a dirty pass pays nothing, which with ~70% of passes touching left passing rarely paid).
            const pay = (R.pass ?? 0) * (0.5 + 0.5 * clamp(1 - took / T, 0, 1));
            add('pass', o.dirty ? pay * (R.passDirty ?? 0) : pay);
            stats.passes = (stats.passes ?? 0) + 1;
            if (o.dirty) { stats.dirty = (stats.dirty ?? 0) + 1; (stats.dirtyWhy ??= {})[o.why] = (stats.dirtyWhy[o.why] ?? 0) + 1; }
          } else { add('lost', -(R.lost ?? R.pass ?? 0)); stats.lostP = (stats.lostP ?? 0) + 1; }
          o.pend = null; o.closeAt = null; o.dirty = false;
        }
      }
      if (stuck) { add('stuck', -(R.stuck ?? 0) * dt); stats.stuckS = (stats.stuckS ?? 0) + dt; }
      if (R.behind) add('behind', -R.behind * dt * a.opp.filter((o) => o.ahead).length);
      if (this.cfg.challenge) a.cleared = a.opp.every((o) => !o.ahead && !o.pend);
    }
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
      // Per-agent lap verdicts (evaluations): [agent, tick, clean, lap time, game state, first track-limit breach s this lap].
      stats.lapEv?.push([(stats.base ?? 0) + a.k, stats.tick ?? 0, clean ? 1 : 0, +(c.race.lastLap ?? 0).toFixed(3), c.race.lastState ?? null, a.cutS ?? null]);
      a.cutS = null;
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
    if (done) add('terminal', -(R.terminal ?? 3));
    if (done && why !== 'dq') this.noteFailure(c.s);
    if (done) stats.endEv?.push([(stats.base ?? 0) + a.k, stats.tick ?? 0, why, Math.round(c.s)]);
    if (done && stats.wrecks && stats.wrecks.length < 64) stats.wrecks.push([this.track.id, Math.round(c.s), why, +c.speed.toFixed(1), +c.lateral.toFixed(1)]);
    const trunc = !done && (a.t >= a.horizon || a.cleared);
    return { reward, risk, done, trunc, why: why ?? (a.cleared ? 'cleared' : trunc ? 'horizon' : null) };
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
