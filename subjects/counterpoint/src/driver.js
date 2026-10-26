// COUNTERPOINT driver. With nobody near, the pilot drives the racing line. With rivals near, the planner replays the
// next seconds of the fight through the game's physics for each candidate move every `period` seconds and the pilot
// drives the move that came out best. The live car runs the same pilot and the same follow rule as its rollouts.
// Given a worker (`remote`), the planning runs there on a copy of the live state and the car keeps driving its last
// move until the answer is back; without one it plans inline, on the spot.
import { Pilot } from './pilot.js';
import { RivalBook, rivalPrototype } from './rivals.js';
import { Planner } from './planner.js';
import { followCap, moveCap } from './follow.js';
import { clamp } from '../../../game/engine/sim/math.js';
import { carState, pilotState, rivalState, surfaceState } from './state.js';

export const DEFAULTS = { period: 0.2, horizon: 2.4, dt: 1 / 60, robust: 4, fightRivals: 2, simRivals: 3, reflex: true };
const GRIDS = 2; // seconds between copies of the rubber and water grids to the worker
const SIDE = { L: -1, LL: -1, R: 1, RR: 1 };

export class CounterpointDriver {
  constructor(track, options = {}, remote = null) {
    this.track = track; this.o = { ...DEFAULTS, ...options };
    this.pilot = new Pilot(track, this.o.pilot ?? {});
    this.book = new RivalBook(track);
    this.planner = new Planner(track, this.book, this.o);
    this.remote = remote;
    if (remote) {
      remote.onmessage = ({ data }) => this.receive(data);
      remote.postMessage({ type: 'init', scenario: track.scenario, options: this.o });
    }
    this.reset();
  }
  reset() {
    this.clock = 0; this.due = 0; this.move = null; this.book.reset(); this.planner.reset(); this.pilot.classId && this.pilot.reset();
    this.reflexes = 0; this.planMs = 0; this.planMax = 0; this.plans = 0;
    this.seq = 0; this.waiting = null; this.sentAt = 0; this.lag = 0; this.lagMax = 0; this.gridsAt = -Infinity; this.remoteStats = null; this.remoteError = null;
    this.explained = null; this.log = []; this.counts = { switches: 0, passes: 0, losses: 0, contacts: 0, forecasts: 0 }; this.sides = new Map(); this.dmg = null;
    this.remote?.postMessage({ type: 'reset' });
  }
  prepare(car) {
    if (this.pilot.classId === car.classId) return;
    this.remote?.postMessage({ type: 'warm', car: carState(car) });
    this.pilot.prepare(car);
    // The ego class's pilot is the rivals' prototype too: one line per class, built once.
    this.book.pilots.set(car.classId, rivalPrototype(this.pilot));
  }
  note(text) { this.log.push({ t: this.clock, text }); if (this.log.length > 60) this.log.shift(); }
  /** A plan came back from the worker: adopted if it answers the last request and the fight is still on. */
  receive(d) {
    if (d.type === 'error') { this.remoteError = d.message; this.note(`planner error: ${d.message.split('\n')[0]}`); }
    if (d.seq !== this.waiting) return;
    this.waiting = null;
    const lag = this.clock - this.sentAt; this.lag = lag; this.lagMax = Math.max(this.lagMax, lag);
    if (d.type !== 'plan') return;
    this.planMs += d.ms; this.planMax = Math.max(this.planMax, d.ms); this.plans++;
    this.remoteStats = { rollouts: d.rollouts, carSteps: d.carSteps, decisions: d.decisions };
    if (this.near?.length) this.adopt(d.move, d.explain);
  }
  adopt(m, explain) {
    const prev = this.move;
    // A plan that continues the path already driven keeps its reflex: one fresh plan per path, not one per plan.
    if (prev?.reflexed && prev.follow === m.follow && Math.abs(prev.lane - m.lane) < 0.6) m.reflexed = true;
    this.move = m; this.explained = explain;
    if (prev?.key !== m.key) {
      this.counts.switches++;
      const second = explain?.runnerUp;
      this.note(`${prev?.key ?? 'pace'} → ${m.key} (${m.score.toFixed(1)} m${second ? `, beats ${second.key} by ${(m.score - second.score).toFixed(1)}` : ''})`);
    }
    const k = explain?.habit?.contact ?? explain?.worst?.contact;
    if (k) { this.counts.forecasts++; if (prev?.key !== m.key) this.note(`forecasts contact with #${k.id} in ${k.t} s at ${k.closing} m/s`); }
  }
  request(car, near) {
    const seq = ++this.seq, grids = this.clock - this.gridsAt >= GRIDS;
    if (grids) this.gridsAt = this.clock;
    this.remote.postMessage({ type: 'plan', seq, car: carState(car), pilot: { ...pilotState(this.pilot), trace: null, trace_: null },
      near: near.slice(0, 4).map(({ r, ds }) => ({ r: rivalState(r), ds })), surface: surfaceState(this.track, grids) });
    this.waiting = seq; this.sentAt = this.clock;
  }
  /** Passes, places lost and contacts, for the event log. */
  watch(car, near) {
    for (const { r, ds } of near) {
      const was = this.sides.get(r.id);
      if (Math.abs(ds) < 25) {
        if (was > 0 && ds < 0) { this.counts.passes++; this.note(`passed #${r.id}${this.move ? ` with ${this.move.key}` : ''}`); }
        if (was < 0 && ds > 0) { this.counts.losses++; this.note(`lost the place to #${r.id}`); }
      }
      this.sides.set(r.id, Math.sign(ds) || was);
    }
    if (this.dmg != null && car.damage > this.dmg + 0.002) { this.counts.contacts++; this.note(`contact: +${((car.damage - this.dmg) * 100).toFixed(1)}% damage`); }
    this.dmg = car.damage;
  }
  update(car, cars, dt, context = {}) {
    this.prepare(car);
    this.clock += dt;
    this.book.observe(car, cars, dt);
    const near = this.book.near(car), length = this.track.length;
    this.near = near; this.watch(car, near);
    if (!near.length) { if (this.move) this.note('free air'); this.move = null; this.explained = null; }
    else if (this.remote) {
      if ((this.clock >= this.due || !this.move) && this.waiting == null) { this.request(car, near); this.due = this.clock + this.o.period; }
      // Until the first plan of a fight is back, hold the lane the car is in and follow.
      this.move ??= { key: 'hold', lane: this.pilot.lateral, follow: true, score: 0, cands: [], waiting: true };
    } else if (this.clock >= this.due || !this.move) {
      const t0 = performance.now();
      const m = this.planner.plan(car, this.pilot, near);
      const ms = performance.now() - t0; this.planMs += ms; this.planMax = Math.max(this.planMax, ms); this.plans++;
      this.adopt(m, this.planner.explain(m));
      this.due = this.clock + this.o.period;
    }
    const m = this.move;
    let cap = moveCap(car, cars, length, m);
    // Reflex: a pressing move whose car ahead is on the brakes (it brakes sooner or harder than forecast) gets the hard
    // follow limit (no reaction allowance) at once and one fresh plan on the next tick. Only a car that is braking
    // counts: in a tow at speed the hard limit is always below the car's speed (the wake costs it brakes), so judged
    // on the limit alone the reflex would cut the throttle on every straight, a press it was asked to drive.
    if (m && !m.follow && this.o.reflex) {
      const braking = cars.filter((o) => o !== car && !o.ghost && (o.controls?.brake ?? 0) > 0.15);
      const hard = braking.length ? followCap(car, braking, length, { react: 0 }) : Infinity;
      if (hard < car.speed - 1) { cap = Math.min(cap, hard); if (!m.reflexed) { m.reflexed = true; this.due = 0; this.reflexes++; this.note(`reflex: ${m.key} car ahead braking, hard follow`); } }
    }
    this.cap = cap;
    // A doors move rides its gap beside the rival as it moves, not the lane it was planned at.
    let lane = m?.lane ?? 0;
    if (m?.doors) { const r = this.near?.find(({ r }) => r.id === m.doors.id)?.r; if (r) lane = clamp(this.pilot.line.locate(r.car.x, r.car.z, this.pilot.hint).e + m.doors.w, m.doors.lo, m.doors.hi); }
    this.pilot.command = { lateral: lane, cap, mode: m?.key ?? 'PACE', late: m?.late ?? 0 };
    return this.pilot.update(car, cars, dt, context);
  }
  /** What the move means in racing terms: the intent, the rival it is about and the side. */
  reading() {
    const m = this.move, near = this.near ?? [];
    if (!m) return { intent: 'PACE', sub: 'free air · racing line' };
    if (m.waiting) return { intent: 'PLAN', sub: 'first plan of the fight on its way' };
    const press = !m.follow, g = /^(LL|RR|L|R)([^!>]+)/.exec(m.key), how = m.late ? 'braking late' : 'pressing';
    if (m.yieldTo != null) {
      const n = near.find((x) => String(x.r.id) === String(m.yieldTo));
      return { intent: 'YIELD', sub: `dropping in behind #${m.yieldTo}${n ? ` · ${n.ds >= 0 ? 'nose behind' : 'nose ahead'} ${Math.abs(n.ds).toFixed(1)} m` : ''}`, focus: String(m.yieldTo), kind: 'yield' };
    }
    if (g) {
      const n = near.find((x) => String(x.r.id) === g[2]), ds = n?.ds ?? 0, side = SIDE[g[1]], wide = g[1].length === 2;
      const where = `${side < 0 ? 'left' : 'right'}${wide ? ' wide' : ''} of #${g[2]}`;
      if (ds > 4) return { intent: press ? 'ATTACK' : 'FOLLOW', sub: `${where} · ${press ? how : 'lining up'} ${ds.toFixed(0)} m back`, focus: g[2], kind: press ? 'attack' : 'follow', side };
      if (ds >= -4) return { intent: 'ALONGSIDE', sub: `${where}${m.late ? ' · braking late' : ''} · ${ds >= 0 ? 'nose behind' : 'nose ahead'} ${Math.abs(ds).toFixed(1)} m`, focus: g[2], kind: 'alongside', side };
      return { intent: 'DEFEND', sub: `${where} · ${(-ds).toFixed(0)} m ahead of it`, focus: g[2], kind: 'defend', side };
    }
    const ahead = near.filter((x) => x.ds > 0).sort((a, b) => a.ds - b.ds)[0], behind = near.filter((x) => x.ds < 0 && x.ds > -15)[0];
    const what = m.key.startsWith('line') ? 'racing line' : 'holding its lane';
    if (ahead && ahead.ds < 40) return { intent: press ? 'ATTACK' : 'FOLLOW', sub: `${what} · ${press ? 'pressing' : 'in the tow of'} #${ahead.r.id} ${ahead.ds.toFixed(0)} m`, focus: ahead.r.id, kind: press ? 'attack' : 'follow' };
    if (behind) return { intent: 'DEFEND', sub: `${what} · #${behind.r.id} ${(-behind.ds).toFixed(0)} m behind`, focus: behind.r.id, kind: 'defend' };
    return { intent: 'RACE', sub: `${what} · rivals near` };
  }
  debug() {
    const m = this.move, r = this.planner.rollouts, x = this.explained, rd = this.reading(), t = this.pilot.trace, st = this.remoteStats;
    return { architecture: 'COUNTERPOINT', ...rd, key: m?.key ?? null, lane: m?.lane ?? 0, follow: m?.follow ?? null,
      score: m?.score, candidates: m?.cands, near: x?.near ?? [], runnerUp: x?.runnerUp ?? null,
      terms: x?.habit?.terms ?? null, worstTerms: x?.worst?.terms ?? null, worstHyp: x?.worst?.hyp ?? null, contact: x?.habit?.contact ?? x?.worst?.contact ?? null,
      decisions: st?.decisions ?? this.planner.decisions, rollouts: st?.rollouts ?? r.count, carSteps: st?.carSteps ?? r.steps,
      reflexes: this.reflexes, planMs: this.planMs, planMax: this.planMax, plans: this.plans, remote: !!this.remote, lag: this.lag, lagMax: this.lagMax, remoteError: this.remoteError,
      cap: this.cap, speed: t?.vNow, target: t?.v, grip: t?.grip, beta: t?.beta, wake: this.pilot.wakeSm, pace: this.pilot.gp, veto: this.pilot.veto,
      counts: this.counts, log: this.log, trace: t };
  }
  /** The simulated future of the chosen move, the other moves' paths and the rivals' forecasts, for the 3D view. */
  visualDebug() {
    const x = this.explained;
    if (!x) return null;
    const near = this.near ?? [], focus = this.reading().focus;
    const kindOf = (id) => { const ds = near.find((n) => String(n.r.id) === String(id))?.ds ?? 0; return ds > 4 ? 'ahead' : ds >= -4 ? 'alongside' : 'behind'; };
    const points = [...x.habit.pts, ...x.habit.tail.slice(1)];
    return { trackingPoint: points[2] ?? points[0], selectedTrajectory: { points, mode: x.key, color: '#ff9e3d' },
      candidates: x.options.map((o) => ({ kind: o.key, score: o.score, chosen: o.key === x.key, points: o.pts })),
      extras: { rivals: x.habit.rivals.map((q) => ({ id: q.id, pts: q.pts, kind: kindOf(q.id), focus: String(q.id) === String(focus) })),
        worst: x.worst ? { hyp: x.worst.hyp, rivals: x.worst.rivals } : null, contact: x.habit.contact ?? x.worst?.contact ?? null } };
  }
}
