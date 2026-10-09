import { clamp } from '../../apex/src/math.js';
import { OFFSETS, LINE_LANE } from './atlas.js';
import { Rollout } from './rollout.js';
import { changeLength } from './lattice.js';

const wrap = (x, L) => ((x + L * 1.5) % L) - L / 2;

/** A committed plan: lateral position and the following cap along the road, from the car to the horizon. */
class Committed {
  constructor(p, L) { Object.assign(this, p); this.L = L; }
  x(s) { return wrap(s - this.s0, this.L) / this.dS; }
  latAt(s) {
    const x = this.x(s); if (x < 0 || x > this.K) return NaN;
    const k = Math.min(this.K - 1, Math.floor(x)), f = x - k;
    return this.d[k] * (1 - f) + this.d[k + 1] * f;
  }
  capAt(s) {
    const x = this.x(s); if (x < 0) return this.cap[0]; if (x > this.K) return Infinity;
    const k = Math.min(this.K - 1, Math.floor(x)), f = x - k;
    return this.cap[k] === Infinity || this.cap[k + 1] === Infinity ? Math.min(this.cap[k], this.cap[k + 1]) : this.cap[k] * (1 - f) + this.cap[k + 1] * f;
  }
}

/**
 * The single owner of the trajectory. On a fixed clock the lattice proposes (best plan per distinct first move);
 * the rollout builds each proposal as the exact lane the controller would follow and drives it against the
 * forecasts; the arbiter commits the cheapest, hands its lane to the controller, and keeps the books on every
 * decision: what it predicted, what then happened, how far the lattice's own estimate was from the executor's.
 */
export class Arbiter {
  constructor(driver) { this.driver = driver; this.rollout = new Rollout(driver); this.reset(); }
  reset() {
    this.plan = null; this.path = null; this.clock = Infinity; this.state = 'PACE'; this.events = []; this.first = -1;
    this.rollout?.reset();
    this.stats = { plans: 0, rolled: 0, attacks: 0, passes: 0, defends: 0, avoids: 0, lost: 0, maxMs: 0, sumMs: 0,
      // decision books
      override: 0, dpGap: 0, dpGapAbs: 0, dpN: 0, changes: 0,
      pred: { n: 0, err: 0, abs: 0 }, predByState: {},
      attempt: { open: 0, made: 0, failed: 0, time: 0 }, defence: { open: 0, held: 0, broken: 0 } };
    this.order = new Map(); this.pending = []; this.attempts = new Map(); this.covers = new Map();
  }
  update(now, car, me, field, forecast, dt) {
    const d = this.driver, o = d.options, line = d.line;
    this.clock += dt;
    this.settle(now, me);
    // a slide is no time to change the plan: hold it until the controller has the car again
    const sliding = d.control.stability < 0.5 && this.plan;
    if (sliding) this.stats.held = (this.stats.held ?? 0) + 1;
    if (!sliding && (this.clock >= (o.planPeriod ?? 0.1) || this.plan === undefined)) {
      this.clock = 0;
      forecast.begin(now);
      const t0 = d.clockMs?.() ?? 0;
      // The racing line is the plan until something on the road changes it: traffic in reach, or water to read.
      const reach = clamp(me.v * 4, 120, 400);
      const busy = !o.neverPlan && (o.alwaysPlan || field.list.some((r) => r.ds > -35 && r.ds < reach) || (d.track.water?.live && (d.track.wetness ?? 0) > 0.05 && o.wetRoute !== false));
      const p = busy ? d.lattice.plan(car, me, field.list, forecast, this.plan, { defend: o.defend !== false, anchor: this.anchor(me) }) : null;
      if (p) this.decide(p, me, car, field, now);
      else { this.plan = null; this.release(); this.path = null; this.state = 'PACE'; this.first = -1; }
      const ms = (d.clockMs?.() ?? 0) - t0; this.stats.sumMs += ms; this.stats.maxMs = Math.max(this.stats.maxMs, ms);
      this.stats.plans++;
      this.track(field, now);
    }
    return this.path ?? line;
  }
  /** Where the committed path (or the line) puts the car now, as shift and slope from the line; null when the car is off it. */
  anchor(me) {
    const line = this.driver.line, path = this.path ?? line, st = line.stationOf(me.s), i = Math.floor(st), f = st - i;
    const pl = path.sample(path.lat, i, f, 0), ll = line.sample(line.lat, i, f, 0);
    // displaced (contact, an avoided car) and back under control: plan from the car, with a gentle start; a car that
    // is sliding is the controller's to catch, and its drift must not become the plan
    if (this.path && Math.abs(me.d - pl) > (this.driver.options.anchorTol ?? 6) && this.driver.control.stability > 0.8) {
      this.stats.reanchor = (this.stats.reanchor ?? 0) + 1;
      const v = Math.max(8, me.v), sl = (line.sample(line.lat, i, f, 4) - line.sample(line.lat, i, f, -4)) / 8;
      return { d0: me.d - ll, p0: clamp(me.vl / v - sl, -0.08, 0.08), c0: 0, keep: null };
    }
    const off = (x) => path.sample(path.lat, i, f, x) - line.sample(line.lat, i, f, x), o0 = pl - ll, a = off(-4), b = off(4);
    // the committed first transition, if the car is still in it: its target lane and the road it has left
    const p = this.plan, rem = p && p.firstEnd != null ? wrap(p.firstEnd - me.s, this.driver.track.length) : 0;
    return { d0: o0, p0: clamp((b - a) / 8, -0.25, 0.25), c0: clamp((b - 2 * o0 + a) / 16, -0.05, 0.05), keep: rem > 2 ? { lane: p.first, rem } : null };
  }
  /** Beside candidates: both sides of the nearest racing target ahead (or alongside), tracking its forecast. */
  beside(p, me) {
    const d = this.driver, o = d.options, out = [], wE = me.halfWidth ?? 0.98;
    let f = null;
    for (const g of p.fs) { const r = g.r; if (!r.target || r.mate || r.ds < -4 || r.ds > (o.besideRange ?? 40)) continue; if (!f || r.ds < f.r.ds) f = g; }
    if (!f) return out;
    const r = f.r, v = Math.max(12, me.v), aT = o.besideA ?? 5, line = d.line, st = line.stationOf(me.s);
    const ll = line.sample(line.lat, Math.floor(st), st % 1, 0);
    for (const side of [-1, 1]) {
      const gap = wE + r.across + (o.besideClear ?? 0.25), off = r.d + side * gap - ll;
      if (Math.abs(off) > d.atlas.bound + 0.5) continue;   // no road on that side
      const entry = clamp(changeLength(Math.max(0.5, Math.abs(r.d + side * gap - me.d)), v, aT), 25, 160);
      const hold = Math.max(70, v * 2.3, Math.max(0, r.ds) + v), rejoin = changeLength(3, v, o.rejoinA ?? 4);
      if (entry + hold > p.K * p.dS + 200) continue;
      const lane = OFFSETS.reduce((bi, x, k) => Math.abs(x - off) < Math.abs(OFFSETS[bi] - off) ? k : bi, 0);
      out.push({ beside: { f, side, gap, entry, hold, rejoin, id: r.id }, K: p.K, dS: p.dS, first: lane, last: LINE_LANE, tow: 0, segs: null });
    }
    return out;
  }
  release() { this.rollout.busy.clear(); if (this.path) this.rollout.busy.add(this.path); }
  decide(p, me, car, field, now) {
    const d = this.driver, o = d.options, line = d.line, R = this.rollout, lam = o.commit ?? 0.01;
    // candidates: the best few distinct first moves, and always the racing line
    const props = p.props.slice(0, o.rollouts ?? 3);
    const lineProp = p.props.find((x) => x.forced) ?? p.props.find((x) => x.first === LINE_LANE);
    if (lineProp && !props.includes(lineProp)) props.push(lineProp);
    // the incumbent: the committed path itself, re-scored against this moment's forecasts like every challenger
    const hold = o.holdCandidate !== false && this.path && this.plan ? { hold: this.path, K: p.K, dS: p.dS, first: this.first, last: this.plan.last, tow: this.plan.tow, segs: null } : null;
    if (hold) props.unshift(hold);
    if (o.beside !== false) props.push(...this.beside(p, me));
    R.busy.clear(); if (this.path) R.busy.add(this.path);
    let best = null; const evs = [];
    for (const prop of props) {
      const ev = R.evaluate(prop, p, me, car, this.path);
      // a challenger has to beat the incumbent by a margin (the forecasts are noisy: near-ties must not flip the path
      // every 0.1 s); going back to the racing line needs less. Without an incumbent, changing the first move costs.
      const sameSide = prop.beside && this.plan?.side === prop.beside.side && this.plan?.target === prop.beside.id;
      if (hold) { if (prop !== hold && !sameSide) ev.score += prop.first === LINE_LANE ? (o.lineMargin ?? 0.05) : (o.holdMargin ?? 0.15) + lam * Math.abs(OFFSETS[prop.first] - OFFSETS[this.first]); }
      else if (this.first >= 0 && prop.first !== this.first && prop.first !== LINE_LANE) ev.score += (o.switchMargin ?? 0.06) + lam * Math.abs(OFFSETS[prop.first] - OFFSETS[this.first]);
      evs.push(ev); this.stats.rolled++;
      if (!best || ev.score < best.score) best = ev;
    }
    // leaving the line only pays when it passes someone or avoids a real contact on it: routing around a car only to
    // escape its following cap gives the line to the cars behind
    const lineEv = evs.find((e) => e.p.forced) ?? evs.find((e) => e.p.first === LINE_LANE && !e.p.hold && !e.p.beside);
    const routeGate = o.routeGate ?? -1;   // off by default: measured worse (4.67 at 0.5, 5.58 at 1.5 vs 4.33 off)
    if (lineEv && best !== lineEv && best.passes <= 0 && p.defend == null && lineEv.contact < routeGate && best.maxDev > 1.2 && !(best.p.hold && this.state === 'ATTACK')) best = lineEv;
    this.lastEvs = evs;
    // books: does the lattice agree with the executor about its own favourite?
    const dp = evs.find((e) => !e.p.hold);
    if (Number.isFinite(dp.tH) && Number.isFinite(dp.p.tK)) { const g = dp.p.tK - dp.tH; this.stats.dpGap += g; this.stats.dpGapAbs += Math.abs(g); this.stats.dpN++; }
    if (best !== dp && !best.p.hold) this.stats.override++;
    if (best.p.hold) this.stats.kept = (this.stats.kept ?? 0) + 1;
    else if (this.first >= 0) this.stats.changes++;
    // the chosen lane's profile for the controller starts at what the line carries there (or faster): the scoring
    // profile started at the car's own speed, which is honest about the time but would only ever ask for gentle throttle
    const lane = best.lane;
    for (const ev of evs) if (ev !== best) R.busy.delete(ev.lane);
    const snap = o.lineSnap ?? 0.3, onLine = best.maxDev < snap && Math.abs(p.start.d0) < snap;
    if (this.path && this.path !== lane) R.busy.delete(this.path);
    if (onLine) { R.busy.delete(lane); this.path = null; }
    else {
      const iE = line.idx(best.i0 + best.n), mass = car.spec.mass + car.fuel * 0.75;
      lane.speedsWindow(d.model, best.i0, best.n, Math.max(car.speed, line.v[line.idx(best.i0)]), line.v[iE], { ...d.sopt, mass, vbrkEnd: line.vbrk[iE], jerk: o.laneJerk ?? d.model.jerk });
      this.path = lane;
    }
    const lay = best.lay;
    // a cap is a speed at a place: the car has to be able to brake to it, so every earlier layer is capped too
    const b = (o.envBrake ?? 0.6) * d.model.brake(30);
    for (let k = p.K - 1; k >= 0; k--) lay.cap[k] = Math.min(lay.cap[k], Math.sqrt(lay.cap[k + 1] * lay.cap[k + 1] + 2 * b * p.dS));
    this.plan = new Committed({ s0: p.s0, dS: p.dS, K: p.K, firstEnd: best.p.hold ? this.plan.firstEnd : best.p.beside ? (me.s + best.p.beside.entry) % d.track.length : (p.s0 + best.p.segs[0].k1 * p.dS) % d.track.length,
      side: best.p.hold ? this.plan.side : best.p.beside?.side ?? 0, target: best.p.hold ? this.plan.target : best.p.beside?.id ?? null, d: lay.d, t: lay.t, cap: lay.cap, first: best.p.first, last: best.p.last,
      passes: best.passes, tow: best.p.tow, defend: p.defend, score: best.score, edges: p.edges, ids: best.ids }, d.track.length);
    this.first = best.p.first;
    this.label(best, p, field, now);
    // a prediction to check: where the executor says the car will be 1.5 s from now
    const L = d.track.length;
    for (let k = 1; k <= p.K; k++) if (lay.t[k] >= 1.5) { this.pending.push({ s: (p.s0 + k * p.dS) % L, due: now + lay.t[k], state: this.state }); break; }
    if (this.pending.length > 40) this.pending.shift();
  }
  /** Close predictions the car has reached. */
  settle(now, me) {
    const L = this.driver.track.length, P = this.stats.pred;
    for (let q = this.pending.length - 1; q >= 0; q--) {
      const e = this.pending[q], dx = wrap(me.s - e.s, L);
      if (dx < 0 && now - e.due < 4) continue;
      this.pending.splice(q, 1);
      if (dx < 0 || dx > 30) continue;   // never reached (pit, spin, off) or skipped over: no evidence either way
      const err = now - e.due; P.n++; P.err += err; P.abs += Math.abs(err);
      const b = (this.stats.predByState[e.state] ??= { n: 0, err: 0, abs: 0 }); b.n++; b.err += err; b.abs += Math.abs(err);
    }
    // attempts and covers that ran out
    for (const [id, a] of this.attempts) if (now - a.t0 > 8) { this.attempts.delete(id); this.stats.attempt.failed++; }
    for (const [id, c] of this.covers) if (now - c.t0 > 6) { this.covers.delete(id); this.stats.defence.held++; }
  }
  label(ev, p, field, now) {
    const prev = this.state;
    const dev = ev.maxDev;
    this.state = ev.passes > 0 ? 'ATTACK' : p.defend != null ? 'DEFEND' : ev.p.tow > 0.35 ? 'TOW' : 'PACE';
    if (this.state === 'PACE' && dev > 1.2 && field.list.some((r) => r.ds > 0 && r.ds < 120)) this.state = 'ROUTE';
    if (this.state === 'ATTACK' && prev !== 'ATTACK') {
      this.stats.attacks++;
      // the rival the attack is for: the nearest same-class car ahead
      const r = field.list.find((x) => x.target && !x.mate && x.ds > 0 && x.ds < 60);
      if (r && !this.attempts.has(r.id)) { this.attempts.set(r.id, { t0: now }); this.stats.attempt.open++; }
    }
    if (this.state === 'DEFEND' && prev !== 'DEFEND') {
      this.stats.defends++;
      if (!this.covers.has(p.defend)) { this.covers.set(p.defend, { t0: now }); this.stats.defence.open++; }
    }
    if (this.state === 'ROUTE' && prev !== 'ROUTE') this.stats.avoids++;
  }
  /** Order changes against same-class rivals, attributed to the state we were in. */
  track(field, now) {
    for (const r of field.list) {
      if (!r.target || Math.abs(r.ds) > 30) continue;
      const side = Math.sign(r.ds), was = this.order.get(r.id);
      if (was !== undefined && was !== side && side !== 0) {
        if (side < 0) {
          this.stats.passes++; this.events.push({ t: +now.toFixed(1), kind: 'pass', id: r.id, state: this.state });
          const a = this.attempts.get(r.id); if (a) { this.attempts.delete(r.id); this.stats.attempt.made++; this.stats.attempt.time += now - a.t0; }
        } else {
          this.stats.lost++; this.events.push({ t: +now.toFixed(1), kind: 'lost', id: r.id, state: this.state });
          if (this.covers.has(r.id)) { this.covers.delete(r.id); this.stats.defence.broken++; }
        }
        if (this.events.length > 20) this.events.shift();
      }
      if (side !== 0) this.order.set(r.id, side);
    }
  }
  /** Decision books in one line-friendly object. */
  books() {
    const s = this.stats, P = s.pred, f = (x) => +x.toFixed(3);
    return {
      plans: s.plans, rolled: s.rolled, meanMs: f(s.sumMs / Math.max(1, s.plans)), maxMs: f(s.maxMs),
      override: s.override, changes: s.changes, kept: s.kept ?? 0, reanchor: s.reanchor ?? 0, held: s.held ?? 0, dpGap: f(s.dpGap / Math.max(1, s.dpN)), dpGapAbs: f(s.dpGapAbs / Math.max(1, s.dpN)),
      pred: { n: P.n, bias: f(P.err / Math.max(1, P.n)), abs: f(P.abs / Math.max(1, P.n)) },
      predByState: Object.fromEntries(Object.entries(s.predByState).map(([k, b]) => [k, { n: b.n, bias: f(b.err / b.n), abs: f(b.abs / b.n) }])),
      attempt: { ...s.attempt, time: f(s.attempt.time / Math.max(1, s.attempt.made)) }, defence: s.defence,
      passes: s.passes, lost: s.lost
    };
  }
}
