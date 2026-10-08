import { Vehicle } from '../engine/sim/vehicle.js';
import { clamp, damp, lerp, wrap } from '../engine/sim/math.js';

/**
 * Race control cautions, iRacing / WEC style.
 *
 *   green ─▶ fcy ─────────────────────────────▶ ending ─▶ green
 *             │ (heavy crash, blocked track)
 *             └─▶ sc (car leaves pit exit ahead of the leader, field queues)
 *                  └─▶ in ("SC in this lap": lights out, SC peels into the pit lane)
 *                       └─▶ green at the line, leader controls the restart
 *
 * Full course yellow: every car holds FCY_V (80 km/h), gaps stay frozen,
 * nobody overtakes. Safety car: the field closes up behind the safety car in
 * running order, lapped cars between the safety car and the leader are waved
 * past to rejoin at the tail, the pit lane opens once the queue has formed.
 * On circuits longer than LONG_TRACK the queue would take a lap of ~10 min to
 * form, so (as at the Nordschleife) race control only runs Code 60 / FCY.
 *
 * AI cars are driven by a caution autopilot (pure pursuit + speed hold, as the
 * formation lap); their own controllers get the wheel back a second before the
 * green. Humans keep the wheel under a speed limiter and are told their target;
 * a position gained under caution must be handed back or it is a drive-through.
 */
export const CAUTION = {
  fcyV: 22.22,          // 80 km/h
  gap: 12,              // queue spacing behind the car ahead (m)
  catchV: 46,           // speed allowed while closing up to the queue
  closeDecel: 4.5,      // braking the closing-up law plans with (m/s²)
  scSlow: 16, scPace: 38, // safety car: waiting for the leader / leading the queue
  minGreen: 45,         // no new caution within this long of a green flag
  maxPerRace: 3,
  fcyMin: 20,           // shortest FCY (s)
  fcyPits: 6,           // pit lane opens this long into a plain FCY
  clearFor: 6,          // track clear this long before race control ends a caution
  ending: 5,            // "FCY ending" warning (s)
  giveBack: 10          // seconds to hand back a position gained under caution
};
const LONG_TRACK = 8000;

export class RaceControl {
  constructor(race, mode = 'full') {
    this.race = race; this.mode = mode;   // 'off' | 'fcy' | 'full'
    this.phase = 'green'; this.reason = null; this.since = 0; this.count = 0; this.lastGreen = -Infinity;
    this.sc = null; this.scPilot = { steer: 0, hold: 0.2 };
    this.state = race.cars.map(() => ({ steer: 0, hold: 0.2, target: 0, gap: null, pos: null, waved: false, warn: 0, owe: null }));
    this.watch = race.cars.map(() => ({ stopped: 0, damage: 0, hist: [] }));
    this.clear = 0; this.pitsOpen = true; this.formed = false; this.handedOver = false;
    this.queue = [];
    this.longTrack = race.track.length > LONG_TRACK;
  }
  get active() { return this.phase !== 'green'; }
  get label() { return this.longTrack && this.phase !== 'green' && !this.sc ? 'CODE 60' : null; }

  /**
   * Caution pace through the bends: a fraction `k` of the car's own racing-line
   * speed just ahead (the line already carries its braking zones).
   */
  corner(c, s, k) {
    const track = this.race.track, line = this.race.lineFor(c);
    // Worn rubber at the end of a stint carries less speed through the bends.
    const wear = c.wheels.reduce((a, w) => a + (w.tyre.wear ?? 0), 0) / c.wheels.length;
    return line.at(s + Math.max(4, c.speed * 0.2)).speed * k * (1 - (track.wetness ?? 0) * 0.24) * (1 - 0.3 * clamp((wear - 0.4) / 0.5, 0, 1));
  }

  // ── triggers ────────────────────────────────────────────────────────────
  /** Watches every car for a stopped, beached or heavily damaged car; returns the worst reason. */
  detect(dt) {
    const race = this.race, track = race.track, kerb = track.halfWidth + (track.curbWidth ?? 0);
    let worst = null;
    race.entries.forEach((e, i) => {
      const c = e.car, w = this.watch[i], dmg = c.damage ?? 0;
      w.hist.push(dmg); if (w.hist.length > 120) w.hist.shift();
      if (e.retired || e.pit || c.race.finishTime !== null || c.race.progress < 0) { w.stopped = 0; return; }
      w.stopped = c.speed < 3 ? w.stopped + dt : 0;
      const off = Math.abs(c.lateral) > kerb + 1.5;
      // A crash: damage jumps by 0.15 within a second.
      if (dmg - w.hist[0] >= 0.15) { worst = { kind: 'sc', text: `${e.team.short} · HEAVY ACCIDENT`, id: c.id }; w.hist.fill(dmg); }
      else if (w.stopped > 3 && !worst) worst = { kind: off ? 'fcy' : 'sc', text: `${e.team.short} · ${off ? 'BEACHED' : 'STOPPED ON TRACK'}`, id: c.id };
    });
    const hz = race.stewards.hazards();
    if (!worst && hz.length >= 3) worst = { kind: 'sc', text: `MULTI-CAR INCIDENT`, id: hz[0].id };
    return worst;
  }

  /** Track clear: no stopped, spun or crawling car on the racing surface. */
  trackClear() {
    return this.race.stewards.hazards().length === 0 && this.watch.every((w) => w.stopped < 1);
  }

  /** Manual call (debug key, race director). */
  call(kind = 'sc', text = 'RACE DIRECTOR') {
    if (this.phase === 'green' && this.race.phase === 'racing' && !this.race.formation) this.begin({ kind, text, id: null });
  }

  begin(why) {
    const race = this.race;
    this.phase = 'fcy'; this.reason = why.text; this.since = race.time; this.count++; this.clear = 0;
    this.escalate = why.kind === 'sc' && this.mode === 'full' && !this.longTrack;
    this.pitsOpen = false; this.formed = false; this.handedOver = false; this.released = false;
    for (const st of this.state) { st.waved = false; st.warn = 0; st.owe = null; st.captured = false; }
    // Gaps frozen: each car's running order is recorded for the overtaking rule.
    this.order = race.order().filter((c) => this.racing(c)).map((c) => c.id);
    race.log('flag', null, `${this.longTrack ? 'CODE 60' : 'FULL COURSE YELLOW'} · ${why.text}`);
  }

  racing(c) {
    const e = this.race.entries[c.id];
    return !e.retired && c.race.finishTime === null && !c.race.dq;
  }

  // ── safety car ──────────────────────────────────────────────────────────
  deploySc() {
    const race = this.race, lane = race.lane, sc = new Vehicle(race.cars.length, 'SC', '#f2f2f2', 'gt');
    race.fitTyres(sc, 'hard', true); sc.fuel = 40; sc.fuelScale = 0; sc.automatic = true; sc.ghost = true;
    sc.place(race.track, lane.boxEnd, lane.laneAt(lane.boxEnd), 6);
    sc.race = { progress: 0 }; sc.lights = true; sc.inLane = true;
    this.sc = sc; this.scPilot = { steer: 0, hold: 0.25 }; this.scV = CAUTION.scSlow;
    this.phase = 'sc'; this.since = race.time;
    race.log('flag', null, 'SAFETY CAR DEPLOYED · CLOSE UP BEHIND THE SAFETY CAR');
  }

  /** Absolute lateral the safety car steers for (pit lane, rejoin, waving), or null for the racing line. */
  scLat(s) {
    const lane = this.race.lane, sc = this.sc, line = this.race.lineFor(sc), look = clamp(6 + sc.speed * 0.42, 8, 34), own = line.offsetAt(s + look);
    if (this.phase === 'in' && lane.inWindow(s, wrap(lane.entry - 150, lane.L), lane.exit)) return lane.inLane(s) ? lane.laneAt(s) : lerp(own, lane.edgeLat, clamp(1 - lane.d(s, lane.entry) / 150, 0, 1));
    if (sc.inLane) {
      if (lane.inWindow(s, wrap(lane.boxEnd - 5, lane.L), lane.exit)) return lane.laneAt(s);
      sc.inLane = false;
    }
    const from = lane.d(lane.exit, s);
    if (from < 80) return lerp(lane.rejoinLat, own, from / 80);
    return this.waving ? 2.6 : null;
  }

  driveSc(dt) {
    const race = this.race, track = race.track, lane = race.lane, sc = this.sc, st = this.scPilot;
    const s = track.nearest(sc.x, sc.z).s, lat = this.scLat(s), leader = this.leaderCar();
    let target;
    // Parks at the end of the box row once it is in for good.
    if (sc.inLane) target = this.phase === 'in' ? (lane.inWindow(s, lane.boxEnd, lane.exit) ? 0 : Math.min(lane.limit, lane.d(s, lane.boxEnd) * 0.5)) : Math.min(lane.limit, this.corner(sc, s, 0.6));
    else {
      const gap = leader ? wrap(s - leader.s, track.length) : Infinity;
      // Holds back until the leader is on its bumper, then sets a steady queue pace;
      // the pace changes gently so the queue behind does not concertina.
      // A strung-out queue slows it too, so the field bunches up behind.
      const bunch = clamp((130 - this.spread()) / 90, 0, 1);
      const want = this.waving ? CAUTION.scSlow : CAUTION.scSlow + (CAUTION.scPace - CAUTION.scSlow) * (this.phase === 'in' ? 0.55 + 0.45 * bunch : Math.min(clamp((220 - gap) / 140, 0, 1), 0.3 + 0.7 * bunch));
      this.scV = clamp(want, (this.scV ?? CAUTION.scSlow) - 3 * dt, (this.scV ?? CAUTION.scSlow) + 1.5 * dt);
      target = Math.min(this.corner(sc, s, 0.7), this.scV, this.phase === 'in' && lane.d(s, lane.entry) < 220 ? 18 + lane.d(s, lane.entry) * 0.1 : 99);
    }
    pursue(track, race.lineFor(sc), sc, st, s, lat, 0, target, dt);
    sc.step(dt, track, 0);
  }

  leaderCar() { const q = this.queue; return q.length ? this.race.cars[q[0]] : null; }

  // ── main step ───────────────────────────────────────────────────────────
  /** Called once per race step before the drivers. Returns true while caution pilots run. */
  step(dt) {
    const race = this.race, track = race.track, lane = race.lane, L = track.length;
    if (this.mode === 'off' || race.session !== 'race' || race.formation) return false;
    if (this.active && race.finishedAt != null) return this.green('CHEQUERED FLAG UNDER CAUTION');
    this.hz = new Set(race.stewards.hazards().map((h) => h.id));
    const why = this.detect(dt);
    if (this.phase === 'green') {
      const leader = race.order()[0];
      const late = leader && (leader.race.lap >= race.laps || race.finishedAt != null);
      if (why && !late && race.time - this.lastGreen > CAUTION.minGreen && this.count < CAUTION.maxPerRace) this.begin(why);
      else return false;
    } else if (why?.kind === 'sc' && this.phase === 'fcy' && this.mode === 'full' && !this.longTrack) this.escalate = true;

    this.clear = this.trackClear() ? this.clear + dt : 0;
    const t = race.time - this.since;
    this.buildQueue();
    const leader = this.leaderCar();

    if (this.phase === 'fcy') {
      // Pit lane open under a plain full course yellow once everyone has slowed (a safety car keeps it shut until the queue forms).
      if (!this.pitsOpen && !this.escalate && t > CAUTION.fcyPits) {
        this.pitsOpen = true; race.log('flag', null, 'FCY · PIT LANE OPEN');
        for (const e of race.entries) if (!e.pit) e.decidedLap = 0;
      }
      if (this.escalate && leader) {
        // The safety car leaves the pit exit just ahead of the leader.
        const pitRun = lane.d(lane.boxEnd, lane.exit) / lane.limit * CAUTION.fcyV + 60;
        const d = lane.d(track.nearest(leader.x, leader.z).s, lane.exit);
        if (t > 4 && d > pitRun - 160 && d <= pitRun + 0.25 * L) this.deploySc();
      } else if (t > CAUTION.fcyMin && this.clear > CAUTION.clearFor) {
        this.phase = 'ending'; this.since = race.time; race.log('flag', null, 'FCY ENDING · GREEN IN 5 SECONDS');
      }
    } else if (this.phase === 'ending') {
      if (!this.handedOver && t > CAUTION.ending - 1) this.handOver();
      if (t >= CAUTION.ending) return this.green('GREEN FLAG · RACING RESUMES');
    } else if (this.phase === 'sc') {
      if (!this.formed && this.queueFormed()) { this.formed = true; race.log('flag', null, 'FIELD QUEUED · PIT LANE OPEN'); }
      if (!this.pitsOpen && (this.formed || t > 60)) {
        this.pitsOpen = true; if (!this.formed) race.log('flag', null, 'PIT LANE OPEN');
        // Every strategist gets a fresh call this lap now that a cheap stop is on.
        for (const e of race.entries) if (!e.pit) e.decidedLap = 0;
      }
      const scS = track.nearest(this.sc.x, this.sc.z).s;
      // In once every running car is queued up behind it and no one is still due in.
      const pitting = race.entries.some((e) => (e.pit || e.pitPlan) && this.racing(e.car));
      const running = race.cars.filter((c) => this.racing(c) && !this.hz?.has(c.id)).length;
      if (((this.queueFormed() && this.queue.length >= running && !pitting) || t > 200) && this.clear > CAUTION.clearFor && t > 25 && !this.waving && !this.sc.inLane && lane.d(scS, lane.entry) > 150) {
        this.phase = 'in'; this.sc.lights = false;
        race.log('flag', null, 'SAFETY CAR IN THIS LAP');
      }
    } else if (this.phase === 'in') {
      const scS = track.nearest(this.sc.x, this.sc.z).s;
      if (!this.sc.inLane && lane.inWindow(scS, lane.entry, lane.exit)) this.sc.inLane = true;
      if (this.sc.inLane && !this.released && leader) {
        // Green at the line, or 400 m past the pit entry where the line is far beyond it.
        this.released = true;
        const ls = track.nearest(leader.x, leader.z).s, restartS = lane.d(lane.entry, track.finishS) <= 700 ? track.finishS : wrap(lane.entry + 400, L);
        this.restartAt = leader.race.progress + lane.d(ls, restartS);
        race.log('flag', null, `RESTART · ${race.entries[leader.id].team.short} CONTROLS THE PACE`);
      }
      if (this.released) {
        const front = Math.max(...this.queue.map((id) => race.cars[id].race.progress), -Infinity), lead = leader?.speed ?? 30;
        if (!this.handedOver && front > this.restartAt - Math.max(12, lead)) this.handOver();
        if (front >= this.restartAt) return this.green('GREEN FLAG · RESTART');
      }
    }
    if (this.sc) {
      this.waving = this.phase === 'sc' && this.queue.some((id) => this.state[id].waved && wrap(track.nearest(this.sc.x, this.sc.z).s - race.cars[id].s, L) < 90);
      this.driveSc(dt);
    }
    this.overtaking(dt);
    return true;
  }

  handOver() {
    const race = this.race; this.handedOver = true;
    for (const e of race.entries) e.bridges[e.active].reset?.({ cars: race.cars, track: race.track, line: race.lineFor(e.car) });
  }

  green(text) {
    const race = this.race;
    this.phase = 'green'; this.reason = null; this.lastGreen = race.time; this.pitsOpen = true; this.released = false;
    this.sc = null; this.waving = false; this.queue = [];
    // A stop called only for the cheap caution price is off once racing resumes, unless the car is already committed to the lane.
    for (const e of race.entries) {
      const lane = race.lane, s = e.car.s;
      if (!e.pit && e.pitPlan && e.strategist.reason === 'CAUTION' && !lane.inWindow(s, wrap(lane.approach - 40, lane.L), lane.entry)) { e.pitPlan = null; e.strategist.boxThisLap = false; e.strategist.reason = ''; race.log('strategy', e, 'STAY OUT · GREEN'); }
    }
    for (const st of this.state) { st.gap = st.pos = null; st.waved = false; st.warn = 0; st.owe = null; }
    race.log('flag', null, text);
    return false;
  }

  /**
   * Queue order: the running cars by distance behind the safety car (or the
   * frozen running order under FCY). Lapped cars between the safety car and the
   * leader are waved round to the tail.
   */
  buildQueue() {
    const race = this.race, track = race.track, L = track.length;
    // Cars in the pits, spun or stopped are out of the queue until they are going again.
    const cars = race.cars.filter((c) => this.racing(c) && !race.entries[c.id].pit && !this.hz?.has(c.id));
    if (!this.sc) {
      this.queue = cars.sort((a, b) => b.race.progress - a.race.progress).map((c) => c.id);
      return;
    }
    const scS = track.nearest(this.sc.x, this.sc.z).s;
    const behind = (c) => wrap(scS - c.s, L);
    const lead = cars.reduce((a, b) => (b.race.progress > a.race.progress ? b : a), cars[0]);
    if (!lead) { this.queue = []; return; }
    const leadD = behind(lead);
    for (const c of cars) {
      const st = this.state[c.id];
      // Waved: physically between the safety car and the leader while the safety car is out.
      if (this.phase === 'sc' && c !== lead && behind(c) < leadD - 3 && !this.sc.inLane) st.waved = true;
      // Back with the field once it has gone round and is closing on the tail.
      else if (st.waved && behind(c) > leadD) st.waved = false;
    }
    this.queue = cars.sort((a, b) => behind(a) - behind(b)).map((c) => c.id);
    // The leader always heads the queue; waved cars run behind it until they pass the safety car.
    const li = this.queue.indexOf(lead.id); this.queue.splice(li, 1); this.queue.unshift(lead.id);
  }

  /** Largest gap anywhere in the queue (safety car to the last queued car). */
  spread() {
    const race = this.race, L = race.track.length;
    let prev = this.sc, worst = 0;
    for (const id of this.queue) { if (this.state[id].waved) continue; const c = race.cars[id]; worst = Math.max(worst, wrap(prev.s - c.s, L)); prev = c; }
    return worst;
  }
  queueFormed() {
    const race = this.race, L = race.track.length, q = this.queue.filter((id) => !this.state[id].waved);
    if (!q.length || !this.sc) return false;
    let prev = this.sc;
    for (const id of q) { const c = race.cars[id]; if (wrap(prev.s - c.s, L) > CAUTION.gap + 40) return false; prev = c; }
    return true;
  }

  /**
   * Targets for car `c` this step: `limit` is race control's speed (FCY limit,
   * queue spacing, hazards), `target` adds the bend limits the autopilot needs,
   * `lat` is the line it steers for.
   */
  target(c, s) {
    const race = this.race, track = race.track, L = track.length, st = this.state[c.id], dt = 1 / 120;
    let lat = null, law;
    // Stopped or crawling cars ahead: pass them on the other side, slowly.
    let hazard = null;
    for (const o of race.cars) {
      if (o === c || !this.hz?.has(o.id) || o.speed > 8) continue;
      const ahead = wrap(o.s - s, L);
      if (ahead > 0 && ahead < 120 && Math.abs(o.lateral) < track.halfWidth + 1) { hazard = o; break; }
    }
    const qi = this.queue.indexOf(c.id);
    st.pos = qi >= 0 ? qi + 1 : null; st.gap = null;
    if (!this.sc) law = CAUTION.fcyV;
    else {
      const pred = st.waved ? null : qi === 0 ? this.sc : qi > 0 ? this.prevQueued(qi) : null;
      if (st.waved) {
        law = CAUTION.catchV;
        if (wrap(this.sc.s - s, L) < 120) { lat = -2.4; law = Math.max(this.sc.speed + 6, 20); }
      } else if (pred) {
        const gap = wrap(pred.s - s, L); st.gap = gap;
        // Closing up: the fastest speed that still stops the gap shrinking below CAUTION.gap at closeDecel.
        law = this.released && qi === 0 ? CAUTION.scPace - 2
          : gap > CAUTION.gap ? Math.min(CAUTION.catchV, Math.sqrt(pred.speed ** 2 + 2 * CAUTION.closeDecel * (gap - CAUTION.gap)))
          : Math.max(0, pred.speed - (CAUTION.gap - gap) * 0.6);
      } else law = CAUTION.catchV;
    }
    // A car caught at racing speed eases down to the caution limit at 6 m/s² rather than
    // braking at once; hazards and the car right ahead always apply in full.
    const now = race.time;
    if (st.at === undefined || now - st.at > 0.5) st.ease = c.speed;
    st.ease = st.captured ? law : Math.max(law, Math.min(st.ease, c.speed) - 6 * dt);
    law = st.ease;
    if (hazard) {
      lat = hazard.lateral > 0 ? -Math.min(3.2, track.halfWidth - 1.6) : Math.min(3.2, track.halfWidth - 1.6);
      law = Math.min(law, 12 + wrap(hazard.s - s, L) * 0.1);
    }
    // Never run into whatever is right ahead on the same line (pit exits, waved cars), and
    // never merge onto a car alongside: both hold their line and the one behind drops back.
    let alongside = false;
    for (const o of race.cars) {
      if (o === c || race.entries[o.id].retired) continue;
      const ahead = wrap(o.s - s + L / 2, L) - L / 2, side = Math.abs(o.lateral - c.lateral);
      if (ahead > 0 && ahead < 25 && side < 2.4) law = Math.min(law, o.speed - (9 - ahead) * 0.6);
      if (Math.abs(ahead) < 7 && side < 3.4) { alongside = true; if (ahead > 0) law = Math.min(law, o.speed - 2); }
    }
    law = Math.max(0, law);
    const line = race.lineFor(c), look = clamp(6 + c.speed * 0.42, 8, 34);
    if (now - st.at > 0.5 || st.extra === undefined) st.extra = clamp(c.lateral - line.offsetAt(s + look), -6, 6);
    st.at = now;
    // Off the racing line only to pass a hazard or the safety car; the offset slews across.
    const want = lat === null ? 0 : clamp(lat - line.offsetAt(s + look), -6, 6), rate = (hazard ? 2.5 : 1.2) * dt;
    if (!alongside || hazard) st.extra += clamp(want - st.extra, -rate, rate);
    st.limit = law;
    st.target = Math.min(law, this.corner(c, s, !this.sc ? 0.8 : 0.85 + 0.04 * clamp(((st.gap ?? 0) - 30) / 60, 0, 1)));
    return st;
  }
  prevQueued(qi) {
    for (let k = qi - 1; k >= 0; k--) { const id = this.queue[k]; if (!this.state[id].waved) return this.race.cars[id]; }
    return this.sc;
  }

  /**
   * Caution autopilot for AI seats (formation-lap pursuit and speed hold). A car
   * caught at racing speed keeps its own driver, under a lock-aware limiter, until
   * it is down to caution pace: the pursuit pilot is built for caution speeds.
   */
  drive(e, dt, s, context) {
    const c = e.car, st = this.target(c, s), track = this.race.track;
    if (!st.captured) {
      e.bridges[e.active].update(c, this.race.cars, dt, context);
      // The car's own driver handles the bends; the limiter only brings it down to race control's speed.
      const over = c.speed - st.limit, k = c.controls, lock = Math.min(1, Math.abs(k.steer ?? 0) * 2.5);
      if (over > -1.5) c.controls = { ...k, throttle: over <= 0 ? k.throttle * Math.min(1, -over / 1.5) : 0, brake: over > 1 ? Math.max(k.brake, Math.min(0.8, (over - 1) / 4) * (1 - 0.5 * lock)) : k.brake };
      // The autopilot takes over once the car is within its own bend limits and settled.
      if (c.speed < 30 && c.speed < st.target + 1 && Math.abs(c.v) < 1 && Math.abs(c.lateral) < track.halfWidth) { st.captured = true; st.steer = c.controls.steer ?? 0; st.hold = 0.2; }
      return;
    }
    if (this.handedOver) e.bridges[e.active].update(c, this.race.cars, dt, context);
    pursue(this.race.track, this.race.lineFor(c), c, st, s, null, st.extra, st.target, dt);
  }

  /** Human seats keep the wheel; the limiter cuts throttle above the target. */
  limit(e, s) {
    const c = e.car, st = this.target(c, s), over = c.speed - st.limit, k = c.controls;
    if (over > 0) c.controls = { ...k, throttle: k.throttle * clamp(1 - over / 1.5, 0, 1) };
  }

  /**
   * No overtaking under caution: a human who gains a place on track has
   * CAUTION.giveBack seconds to give it back before a drive-through.
   * (AI seats are on the autopilot and keep station.)
   */
  overtaking(dt) {
    const race = this.race;
    if (this.phase === 'in' && this.released) return;
    // Cars that pit leave the order; cars rejoining slot in where they are.
    this.order = this.order.filter((id) => this.racing(race.cars[id]) && !race.entries[id].pit);
    for (const c of race.cars) if (this.racing(c) && !race.entries[c.id].pit && !this.order.includes(c.id)) {
      const k = this.order.findIndex((id) => race.cars[id].race.progress < c.race.progress);
      this.order.splice(k < 0 ? this.order.length : k, 0, c.id);
    }
    race.entries.forEach((e, i) => {
      const st = this.state[i], c = e.car;
      if (e.team.drivers[e.active]?.kind !== 'human' || e.pit || !this.racing(c)) { st.warn = 0; return; }
      if (st.owe === null) {
        // The car the frozen order had directly ahead of this one.
        const k = this.order.indexOf(c.id), ahead = k > 0 ? race.cars[this.order[k - 1]] : null;
        if (ahead && c.race.progress > ahead.race.progress + 4) {
          st.owe = ahead.id; st.warn = CAUTION.giveBack;
          race.log('penalty', e, `${e.team.short} · OVERTAKE UNDER CAUTION · GIVE THE POSITION BACK`);
        }
        return;
      }
      const o = race.cars[st.owe];
      if (!this.order.includes(o.id) || c.race.progress < o.race.progress - 2) { st.owe = null; st.warn = 0; return; }
      st.warn -= dt;
      if (st.warn <= 0) {
        st.owe = null; st.warn = 0;
        race.stewards.penalise(e, 'OVERTAKE UNDER CAUTION');
        // Penalised: the pass stands in the order, the drive-through settles it.
        this.order.splice(this.order.indexOf(c.id), 1); this.order.splice(this.order.indexOf(o.id), 0, c.id);
      }
    });
  }

  snapshot() {
    if (this.mode === 'off') return null;
    const sc = this.sc, race = this.race;
    return {
      phase: this.phase, reason: this.reason, label: this.label, count: this.count, elapsed: this.active ? race.time - this.since : 0,
      pitsOpen: this.pitsOpen, formed: this.formed, released: Boolean(this.released), endingIn: this.phase === 'ending' ? Math.max(0, CAUTION.ending - (race.time - this.since)) : null,
      limit: this.phase === 'fcy' || this.phase === 'ending' ? CAUTION.fcyV : null,
      sc: sc ? { x: sc.x, y: sc.y, z: sc.z, yaw: sc.yaw, roll: sc.roll, pitch: sc.pitch, heave: sc.heave, speed: sc.speed, steering: sc.steering, s: sc.s, lateral: sc.lateral, lights: sc.lights, inLane: sc.inLane } : null
    };
  }
  carState(id) {
    if (!this.active) return null;
    const st = this.state[id];
    return { target: st.target, gap: st.gap, pos: st.pos, waved: st.waved, giveBack: st.owe !== null ? Math.max(0, st.warn) : null };
  }
}

/**
 * Pure pursuit along the racing line (offset by `extra`), or to an absolute
 * lateral `abs`, with a P speed hold: the engine's line-following driver, so it
 * is stable from pit-lane speeds up to caution catch-up pace.
 */
function pursue(track, line, c, st, s, abs, extra, target, dt) {
  const look = clamp(6 + c.speed * 0.42, 8, 34);
  const p = abs !== null && abs !== undefined ? track.at(s + look, abs) : line.at(s + look, extra);
  const dx = p.x - c.x, dz = p.z - c.z, lx = dx * Math.cos(c.yaw) - dz * Math.sin(c.yaw);
  const delta = Math.atan2(2 * c.spec.wheelbase * lx, Math.max(5, dx * dx + dz * dz)), slip = Math.atan2(c.v, Math.max(4, c.u));
  st.steer = damp(st.steer, clamp((delta + slip * 0.45) / c.spec.steeringLock, -1, 1), 10, dt);
  const error = target - c.speed;
  c.automatic = true;
  // Gentle on the throttle, and off it as soon as the rear steps out: cautions come late in
  // stints on worn tyres, when a full-throttle exit would spin the car.
  const slide = Math.abs(Math.atan2(c.v, Math.max(4, Math.abs(c.u))));
  const traction = clamp(1 - (slide - 0.03) * 10, 0.12, 0.75) * (1 - 0.45 * Math.min(1, Math.abs(st.steer) * 2) * clamp(1 - c.speed / 35, 0, 1));
  c.controls = { steer: st.steer, throttle: clamp(error * 0.34 + 0.12, 0, traction), brake: clamp(-error * 0.2, 0, 1) };
}
