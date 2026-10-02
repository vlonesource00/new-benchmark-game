import { wrap } from '../engine/sim/math.js';

// Race control, iRacing-style. Every car (AI or human) collects incident
// points; crossing the limits brings drive-through penalties and finally a
// disqualification. Race control also raises the flags (local yellows, blue
// flags, the meatball for heavy damage) that the HUD and the strategists read.
//
//   0x light contact · 1x off track (all four wheels) · 2x loss of control,
//   wall contact or marshal recovery · 4x heavy car-to-car contact.
//
// Like iRacing, overlapping incidents inside a short window only count once,
// at the highest value: a spin that leaves the track is 2x, not 3x.

export const INCIDENT_POINTS = Object.freeze({ offTrack: 1, lossOfControl: 2, wall: 2, recovery: 2, contact: 4 });
const WINDOW_S = 2.5;
const HEAVY_CONTACT = 3.5;       // m/s closing speed
const WALL_DAMAGE = 0.002;       // damage gained in one step without a car contact
export const MEATBALL_DAMAGE = 0.35;
const PENALTY_LAPS = 3;          // laps to serve a drive-through before the black flag becomes a DQ

/** Incident limits scale gently with race length, as series do. */
export function incidentLimits(laps) {
  const penalty = laps <= 8 ? 17 : laps <= 14 ? 21 : 25;
  return { penalty, every: 8, dq: penalty * 2 + 7 };
}

export class Stewards {
  constructor(race) {
    this.race = race;
    this.limits = incidentLimits(race.laps);
    this.pairs = [];
    this.reset();
  }

  reset() {
    this.state = this.race.entries.map((e) => ({
      inc: 0, window: { until: -1, max: 0 }, off: false, spun: false, clean: 0, damage: e.car.damage ?? 0,
      penalties: [], served: 0, issued: 0, dq: false, log: []
    }));
  }

  of(e) { return this.state[e.car.id]; }

  add(e, points, kind) {
    const st = this.of(e), t = this.race.time, w = st.window;
    let extra = points;
    if (t < w.until) { extra = Math.max(0, points - w.max); w.max = Math.max(w.max, points); }
    else { st.window = { until: t + WINDOW_S, max: points }; }
    if (points === 0) return;
    st.log.push({ time: t, lap: e.car.race.lap, kind, points: extra });
    if (extra <= 0) return;
    st.inc += extra;
    const L = this.limits;
    // One drive-through at the limit, another every `every` points past it.
    const due = st.inc >= L.penalty ? 1 + Math.floor((st.inc - L.penalty) / L.every) : 0;
    while (st.issued < due && !st.dq) {
      st.issued++;
      st.penalties.push({ type: 'drive-through', reason: `${st.inc}x INCIDENTS`, lap: e.car.race.lap });
      this.race.log('penalty', e, `${e.team.short} · DRIVE-THROUGH · ${st.inc}x INCIDENT LIMIT`);
    }
    if (st.inc >= L.dq) this.disqualify(e, `${st.inc}x INCIDENTS`);
  }

  /** Marshal recovery counts as a loss of control. */
  recovered(e) { this.add(e, INCIDENT_POINTS.recovery, 'recovery'); }

  disqualify(e, reason) {
    const st = this.of(e); if (st.dq) return;
    st.dq = true; st.penalties = [];
    this.race.log('penalty', e, `${e.team.short} · BLACK FLAG · DISQUALIFIED · ${reason}`);
    this.race.retire(e, 'DQ');
  }

  /** Called after the physics step with the contact pairs it reported. */
  step(dt) {
    const race = this.race, track = race.track, pairs = this.pairs;
    const kerb = track.halfWidth + (track.curbWidth ?? 0);
    const touched = new Set();
    for (const [a, b, closing] of pairs) {
      touched.add(a); touched.add(b);
      const ea = race.entries[a], eb = race.entries[b];
      if (ea.retired || eb.retired) continue;
      const pts = closing > HEAVY_CONTACT ? INCIDENT_POINTS.contact : 0;
      this.add(ea, pts, 'contact'); this.add(eb, pts, 'contact');
    }
    pairs.length = 0;
    for (const e of race.entries) {
      const c = e.car, st = this.of(e);
      const dmg = c.damage ?? 0, gained = dmg - st.damage; st.damage = dmg;
      if (e.retired || e.pit || c.race.finishTime !== null || race.time < 1) { st.off = st.spun = false; continue; }
      // All four wheels beyond the kerb: the car centre is a half-width past it.
      if (c.speed > 25) st.moving = true;
      const lat = Math.abs(c.lateral);
      // Loss of control: the car points well away from the direction of travel.
      const near = track.at(c.s), slip = Math.abs(Math.atan2(Math.sin(c.yaw - near.heading), Math.cos(c.yaw - near.heading)));
      // One off or spin is one incident: both re-arm only after two seconds of clean
      // driving on track, so a car flailing in the run-off is not charged repeatedly.
      const clean = lat < kerb && slip < 0.45 && c.speed > 10;
      st.clean = clean ? st.clean + dt : 0;
      if (st.clean > 2) st.off = st.spun = false;
      if (!st.off && lat > kerb + 1.0) { st.off = true; this.add(e, INCIDENT_POINTS.offTrack, 'off track'); }
      if (!st.spun && c.speed > 4 && slip > 1.25) { st.spun = true; this.add(e, INCIDENT_POINTS.lossOfControl, 'loss of control'); }
      if (gained > WALL_DAMAGE && !touched.has(c.id)) this.add(e, INCIDENT_POINTS.wall, 'wall contact');
      // Unserved drive-through: black flag turns into a DQ.
      const p = st.penalties[0];
      if (p && c.race.lap - p.lap > PENALTY_LAPS) this.disqualify(e, 'IGNORED BLACK FLAG');
    }
  }

  pendingPenalty(e) { return this.of(e).penalties[0] ?? null; }
  serve(e) {
    const st = this.of(e), p = st.penalties.shift();
    if (p) { st.served++; this.race.log('penalty', e, `${e.team.short} · PENALTY SERVED`); }
    return p;
  }

  /** Cars stopped, spun or crawling on track: each one raises a local yellow. */
  hazards() {
    const out = [];
    for (const e of this.race.entries) {
      const c = e.car, st = this.of(e);
      if (e.retired || e.pit || c.race.finishTime !== null || this.race.phase !== 'racing' || this.race.time < 5) continue;
      // Only cars that were already up to speed: a slow getaway from the grid is no hazard.
      if (st.moving && (st.spun || (st.off && c.speed < 15) || c.speed < 6)) out.push({ id: c.id, s: c.s });
    }
    return out;
  }

  /** The flag a driver sees at this moment (highest priority first). */
  flagFor(e, hazards = this.hazards()) {
    const c = e.car, st = this.of(e), race = this.race, L = race.track.length;
    if (st.dq || st.penalties.length) return 'black';
    if ((c.damage ?? 0) >= MEATBALL_DAMAGE && !e.retired) return 'meatball';
    if (e.pit || e.retired || c.race.finishTime !== null) return null;
    // Blue: a car at least half a lap ahead on progress is right behind on track.
    for (const o of race.cars) {
      if (o === c || race.entries[o.id].pit) continue;
      const behind = wrap(c.s - o.s, L);
      if (behind > 0 && behind < 70 && o.race.progress - c.race.progress > L / 2) return 'blue';
    }
    for (const h of hazards) { if (h.id === c.id) continue; const ahead = wrap(h.s - c.s, L); if (ahead > 0 && ahead < 300) return 'yellow'; }
    return null;
  }

  /** Race-wide flag for the flag panel. */
  raceFlag() {
    const r = this.race;
    if (r.phase === 'finished' || r.finishedAt != null) return 'chequered';
    if (r.phase !== 'racing') return null;
    const leader = r.order()[0];
    return leader && leader.race.lap >= r.laps ? 'white' : 'green';
  }

  summary(e) { const st = this.of(e); return { incidents: st.inc, penalties: st.penalties.length, served: st.served, dq: st.dq, log: st.log.slice(-20) }; }
}
