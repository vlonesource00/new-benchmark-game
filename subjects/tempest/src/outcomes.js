import { HALF_LEN } from './perception.js';

/**
 * Pass outcomes by body clearance, never by state entries or by the order of the car centres.
 * Against every car on the road the relation is `ahead` (its rear is clear of our nose), `behind` (our rear is clear
 * of its nose) or `side` (the bodies overlap along the road). A pass is completed when a car goes from ahead to
 * behind, and retained when it stays clear behind through the whole retain interval. Race passes (same-class rivals)
 * are booked apart from traffic (other classes, cars boxing) and hazards (stopped, spun, retired); pit-lane cars never
 * enter the field. Lost places are the same test the other way round, against race rivals.
 * An attack (the planner entering ATTACK, naming a rival) goes through four steps, each booked once:
 *   declared   the label;
 *   started    the car moves toward a passing corridor: 0.5 m across, away from the rival's track, since the label, or
 *              already clear of its track while closing on it;
 *   overlap    the bodies overlap along the road;
 *   completed  the pass above, against that rival.
 * An attack that stops short fails with the reason: never started, started but never reached the overlap, fell back
 * after the overlap, or stalled alongside.
 */
export class Outcomes {
  constructor(driver) { this.driver = driver; this.reset(); }
  get options() { return this.driver.options; }
  reset() {
    this.rel = new Map(); this.retain = []; this.att = null; this.events = [];
    const k = () => ({ done: 0, kept: 0 });
    this.book = { declared: 0, started: 0, overlap: 0, completed: 0, retained: 0, failed: {}, attackTime: 0, race: k(), traffic: k(), hazard: k(), lost: 0 };
  }
  kind(r) { return r.hazard ? 'hazard' : r.target && !r.mate ? 'race' : 'traffic'; }
  relation(r) { const Ls = HALF_LEN + r.halfLength; return r.ds > Ls ? 'ahead' : r.ds < -Ls ? 'behind' : 'side'; }
  /** The planner entered ATTACK naming `id` (null: the nearest race rival ahead). */
  declare(now, field, id) {
    this.book.declared++;
    const r = (id != null ? field.byId.get(id) : null) ?? field.list.find((x) => x.target && !x.mate && x.ds > 0 && x.ds < 60);
    if (!r) return;
    if (this.att?.id === r.id) { this.att.seen = now; return; }
    if (this.att) this.end(now, 'retargeted');
    this.att = { id: r.id, t0: now, seen: now, d0: field.me.d, side: Math.sign(field.me.d - r.d) || 1, started: false, overlap: false, kind: this.kind(r) };
  }
  update(now, field, state) {
    const o = this.options, B = this.book, me = field.me, ids = new Set();
    for (const r of field.list) {
      ids.add(r.id);
      const rel = this.relation(r), was = this.rel.get(r.id);
      // the last clean relation: a car that drops back into the overlap has not changed it
      if (rel !== 'side') {
        if (was === 'ahead' && rel === 'behind') this.pass(now, r);
        else if (was === 'behind' && rel === 'ahead' && this.kind(r) === 'race') { B.lost++; this.note(now, 'lost', r); }
        this.rel.set(r.id, rel);
      } else if (was === undefined) this.rel.set(r.id, 'side');
    }
    for (const id of this.rel.keys()) if (!ids.has(id)) this.rel.delete(id);
    // retention: clear behind at every check through the interval (a car out of the field is no evidence either way)
    for (let q = this.retain.length - 1; q >= 0; q--) {
      const e = this.retain[q], r = field.byId.get(e.id);
      if (r && this.relation(r) !== 'behind') { this.retain.splice(q, 1); this.note(now, 'undone', r); continue; }
      if (now < e.due) continue;
      this.retain.splice(q, 1); B[e.kind].kept++; if (e.attack) B.retained++;
    }
    const a = this.att; if (!a) return;
    if (state === 'ATTACK') a.seen = now;
    const r = field.byId.get(a.id);
    if (!r) return this.end(now, 'gone');
    const Ls = HALF_LEN + r.halfLength, latGap = Math.abs(r.d - me.d) - ((me.halfWidth ?? 0.98) + r.across);
    if (!a.started && (a.side * (me.d - a.d0) > 0.5 || (latGap > 0.2 && me.v > r.v))) { a.started = true; B.started++; }
    if (!a.overlap && r.ds <= Ls) { a.overlap = true; a.started ||= (B.started++, true); B.overlap++; }
    const why = () => (a.overlap ? (r.ds > Ls ? 'fell-back' : 'stalled-alongside') : a.started ? 'no-overlap' : 'not-started');
    // an attack outlives its label by a moment (the name follows the path with a dwell), not by a lap
    if (now - a.seen > (o.attemptGrace ?? 1.5) && r.ds > Ls) this.end(now, why());
    else if (now - a.t0 > (o.attemptMax ?? 12)) this.end(now, why());
  }
  pass(now, r) {
    const B = this.book, k = this.kind(r), attack = this.att?.id === r.id;
    B[k].done++; this.retain.push({ id: r.id, kind: k, attack, due: now + (this.options.retainT ?? 1) });
    this.note(now, 'pass', r);
    if (attack) { B.completed++; B.attackTime += now - this.att.t0; this.att = null; }
  }
  end(now, why) {
    const a = this.att; this.att = null;
    this.book.failed[why] = (this.book.failed[why] ?? 0) + 1;
    this.events.push({ t: +now.toFixed(1), kind: 'attempt-failed', id: a.id, why, dur: +(now - a.t0).toFixed(1) });
    if (this.events.length > 40) this.events.shift();
  }
  note(now, kind, r) {
    this.events.push({ t: +now.toFixed(1), kind, id: r.id, as: this.kind(r) });
    if (this.events.length > 40) this.events.shift();
  }
  books() {
    const B = this.book;
    return { ...B, failed: { ...B.failed }, race: { ...B.race }, traffic: { ...B.traffic }, hazard: { ...B.hazard }, attackTime: +(B.attackTime / Math.max(1, B.completed)).toFixed(2), retainT: this.options.retainT ?? 1 };
  }
}
