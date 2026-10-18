// ORACLE combat: a lane planner that runs at physics rate on the live field.
//
// Every rival near the car is placed on ORACLE's own line (distance along it and metres right of it) and its
// next three seconds are forecast from what it is doing this instant: its pedals give its acceleration now, its
// measured pace against ORACLE's profile gives where it will brake and how fast it takes the corners, and its
// lateral drift carries it sideways. ORACLE then drives each candidate lane forward on the same clock, with
// the slipstream each rival's wake would give it, the corner speed and path length of running off its line,
// and a rival ahead in the lane forcing it to follow. The lane that ends furthest up the road wins; passing a
// rival is worth a bonus, being passed costs one, and any lane that would put two cars into the same space is
// thrown out. Overtakes fall out of the search (the tow, the pull-out, the late dive up the inside) and so does
// defence (one move to cover the inside of the next corner when a car behind is closing).
import { clamp, wrap } from '../../../game/engine/sim/math.js';
import { envelope, at } from './envelope.js';

const HALF_W = 0.98, HALF_L = 2.28;          // the collision box every car uses
const STEP = 0.1, HORIZON = 4.5;
const SIDE = 2 * HALF_W + 0.45, NOSE = 2 * HALF_L + 0.5;

export class Combat {
  constructor(line, options = {}) {
    this.line = line; this.o = options; this.rivals = new Map(); this.target = null;
    this.lane = 0; this.commit = 0; this.frame = 0; this.plan = null;
  }
  reset() { this.rivals.clear(); this.target = null; this.lane = 0; this.commit = 0; this.plan = null; this.vis = null; this.log = []; this.clock = 0; }
  /** The debugger is reading (visualDebug in the last 0.6 s): forecasts keep their trails. Never changes a decision. */
  get recording() { return this.recAt != null && performance.now() - this.recAt < 600; }
  note(text) { (this.log ??= []).push({ t: this.clock ?? 0, text }); if (this.log.length > 14) this.log.shift(); }

  /** One rival on ORACLE's line: where it is, its lateral drift, and its pace against ORACLE's profile. */
  observe(o, me, dt) {
    const line = this.line, n = line.n, len = n * line.ds;
    let r = this.rivals.get(o.id);
    const loc = line.locate(o.x, o.z, r?.hint ?? -1);
    const gap = wrap(loc.s - me.s + len / 2, len) - len / 2;
    if (!r) { r = { hint: loc.i, e: loc.e, edot: 0, ratio: 1, env: envelope(o.classId), path: new Float32Array(n).fill(NaN), vel: new Float32Array(n).fill(NaN), at: loc.i }; this.rivals.set(o.id, r); }
    else r.edot += (clamp((loc.e - r.e) / Math.max(dt, 1e-3), -6, 6) - r.edot) * Math.min(1, dt * 8);
    r.hint = loc.i; r.e = loc.e; r.gap = gap; r.car = o; r.s = loc.s;
    // Path memory: every car drives its own line lap after lap, so where this rival was at each station (and how fast)
    // is the best forecast of where it will be. Each station passed is blended half-and-half with the laps before.
    if (loc.i !== r.at && o.speed > 5) {
      for (let j = (r.at + 1) % n, c = 0; c < 8; j = (j + 1) % n, c++) {
        r.path[j] = Number.isNaN(r.path[j]) ? loc.e : (r.path[j] + loc.e) / 2; r.vel[j] = Number.isNaN(r.vel[j]) ? o.speed : (r.vel[j] + o.speed) / 2;
        if (j === loc.i) break;
      }
      r.at = loc.i;
    }
    // Pace ratio: how fast this rival drives against ORACLE's profile, learnt continuously off the brakes.
    const p = line.sample(line.v, loc.i, loc.f);
    // rivalPhys: at full throttle a car under the profile is still accelerating out of a slower corner or a fight, which
    // says nothing about its pace, so there the ratio may only rise; it is learnt down only where the driver chooses
    // the speed (part throttle: the corner limit, or a car held to a slower pace).
    const pr = clamp(o.speed / Math.max(5, p), 0.6, 1.3), learn = !this.o.rivalPhys || (o.controls?.throttle ?? 0) < 0.95 || pr > r.ratio;
    if (o.speed > 8 && o.controls?.brake < 0.05 && learn) r.ratio += (pr - r.ratio) * Math.min(1, dt * 0.8);
    // Acceleration this instant, from its pedals (exact, not inferred from its speed trace).
    const c = o.controls ?? {}, drag = 0.5 * 1.225 * o.spec.area * o.spec.cd * o.speed * o.speed / o.spec.mass;
    r.acc = c.brake > 0.02 ? -c.brake * at(r.env.brake, o.speed) - drag : (c.throttle ?? 0) * at(r.env.accel, o.speed) - drag * 0.3;
    return r;
  }

  update(car, cars, loc, v, dt, context = {}) {
    const line = this.line, o = this.o, grip = context.grip ?? 1, me = { s: loc.s, e: loc.e };
    const near = [];
    for (const c of cars) {
      if (c === car || c.ghost) continue;
      const r = this.observe(c, me, dt);
      if (r.gap > -40 && r.gap < 170) near.push(r);
    }
    // fcAudit (benches only): the lateral forecast of every rival up to 40 m ahead, 1 s and 2 s on, scored against
    // where it then is: the forecast's own (remembered path, the offset decaying into it), the offset held, and the
    // path with the offset held; split by whether the path is known there.
    if (o.fcAudit) {
      const A = (this.fa ??= { q: [], k: {} }), now = this.clock ?? 0, tau = o.devTau ?? 1.2, n = line.n;
      for (let j = A.q.length - 1; j >= 0; j--) { const q = A.q[j]; if (now < q.due) continue; A.q.splice(j, 1);
        const r = this.rivals.get(q.id); if (!r || Math.abs(r.gap) > 60) continue;
        const b = (A.k[q.key] ??= { n: 0, fc: 0, hold: 0, path: 0, ed3: 0, ed6: 0 }); b.n++; b.fc += Math.abs(q.fc - r.e); b.hold += Math.abs(q.hold - r.e); b.path += Math.abs(q.path - r.e);
        b.ed3 += Math.abs(q.ed3 - r.e); b.ed6 += Math.abs(q.ed6 - r.e); }
      if (now - (A.last ?? -1) > 0.25) { A.last = now;
        for (const r of near) if (r.gap > 0 && r.gap < 40) for (const H of [1, 2]) {
          const pi = line.locate ? Math.floor(wrap(r.s + r.car.speed * H, n * line.ds) / line.ds) % n : r.hint, p0 = r.path[r.hint], p1 = r.path[pi], known = !Number.isNaN(p0) && !Number.isNaN(p1);
          const pr0 = known ? p0 : 0, pr1 = known ? p1 : 0, dev = r.e - pr0;
          A.q.push({ due: now + H, id: r.car.id, key: `${H}s ${known ? 'known' : 'fresh'}`, fc: pr1 + dev * Math.exp(-H / tau), hold: r.e, path: pr1 + dev,
            ed3: r.e + r.edot * 0.3 * (1 - Math.exp(-H / 0.3)), ed6: r.e + r.edot * 0.6 * (1 - Math.exp(-H / 0.6)) });
        } }
    }
    // Rivals out of range are forgotten so a car re-entering is seen fresh.
    if (this.rivals.size > near.length + 8) for (const [id, r] of this.rivals) if (!near.includes(r) && Math.abs(r.gap) > 400) this.rivals.delete(id);
    this.commit = Math.max(0, this.commit - dt);
    if (!near.length) { this.target = null; this.lane += (0 - this.lane) * Math.min(1, dt * 2); this.plan = null; return { lateral: 0, cap: Infinity, mode: 'PACE' }; }

    // Lanes: metres right of the line. The line itself, the lane held now, and a car's width (plus a clear gap) either
    // side of every rival close enough to matter: a pass, a defence or a tow is always one of those.
    const max = o.maxLane ?? 7;
    // Mid-corner the car can hold its lane or ease back to the line, but a new move off the line is set up on the
    // straights and in the braking zones: a lane change while the corner uses the tyres has no grip to be made with.
    const kc = o.laneK ?? 1 / 70; let kNow = 0;
    for (let d = 0; d <= v * 0.8; d += 4) kNow = Math.max(kNow, Math.abs(line.sample(line.k, loc.i, loc.f, d)));
    let free = kNow < kc || (context.braking && kNow < kc * 2);
    // freeHys: the corner state changes only past a margin either side of the threshold, so a curvature hovering at it
    // does not flip the candidate set (and the lane with it) frame to frame.
    if (o.freeHys || o.moves) { const kk = context.braking ? kc * 2 : kc; const hy = o.freeHys ?? 0.25; this.inCorner = this.inCorner ? kNow > kk * (1 - hy) : kNow > kk * (1 + hy); free = !this.inCorner; }
    this.free = free;
    if (o.moves) return this.moves(car, near, loc, v, grip, dt, free);
    // A rival is in reach when ORACLE could be alongside it within the planning horizon: a lane around a car further up
    // the road is a guess about a pass that the point-mass forecast cannot make reliably.
    // Reach from the forecast itself: staying on the line, does ORACLE close to within a car length or so of this rival
    // inside the horizon? (The instant speed difference is no guide: in a braking zone the follower is always faster.)
    const base = o.reachForecast === false ? null : this.drive(car, near, loc, v, grip, 0);
    const reach = (r) => r.gap > -25 && (base ? (base.closest.get(r) ?? Infinity) < NOSE + (o.reachMargin ?? 4) || Math.abs(r.gap) < NOSE + 3 : r.gap < (o.attackGap ?? 18) + Math.max(0, v - r.car.speed) * 2);
    const alongside = near.some((r) => Math.abs(r.gap) < NOSE + 3);
    // Mid-corner with nobody alongside, an off-line lane is eased back toward the line, never held.
    const lanes = free || alongside || o.cornerHold ? [0, this.lane] : [0, this.lane * 0.5];
    if (free) for (const r of near) if (reach(r)) for (const w of [SIDE + 0.3, SIDE + 1.1]) lanes.push(r.e + w, r.e - w);
    if (!free && alongside && Math.abs(this.lane) > 0.3) lanes.push(this.lane * 0.5);
    // holdT: a lane is not swung across the road in the last seconds before a braking zone: the car would arrive at the
    // brake with lateral speed to kill, in the corner's entry, which is where a car (in a wake above all) lets go. A
    // small trim (a metre) stays allowed.
    let hold = false;
    if (o.holdT && v > 30) for (let d = 0; d < v * o.holdT; d += 5) if (line.sample(line.vb, loc.i, loc.f, d) < v - 4) { hold = true; break; }
    if (hold && !alongside) for (let j = lanes.length - 1; j >= 0; j--) if (Math.abs(lanes[j] - this.lane) > (o.holdTrim ?? 1)) lanes.splice(j, 1);
    if (!lanes.length) lanes.push(this.lane);
    // scoreTau: each candidate is known by what it is (the line, the lane held, a side of a given rival), and is chosen
    // on its score low-passed over this time: one frame's forecast noise does not move the car.
    const keys = o.scoreTau ? ['line', 'hold'] : null;
    if (keys && free) for (const r of near) if (reach(r)) for (const w of [SIDE + 0.3, SIDE + 1.1]) keys.push(r.car.id + '+' + w, r.car.id + '-' + w);
    if (keys && !free && alongside && Math.abs(this.lane) > 0.3) keys.push('half');
    const sm = o.scoreTau ? (this.sm ??= new Map()) : null, seen = new Set();
    let best = null;
    for (let li = 0; li < lanes.length; li++) {
      const raw = lanes[li], lane = clamp(raw, -max, max), plan = this.drive(car, near, loc, v, grip, lane);
      if (sm && keys[li] != null) {
        const k = keys[li], prev = sm.get(k); seen.add(k);
        // An infeasible lane is thrown out now, and its history with it.
        if (plan.score < -500) sm.delete(k); else { plan.score = prev == null ? plan.score : prev + (plan.score - prev) * Math.min(1, dt / o.scoreTau); sm.set(k, plan.score); }
      }
      plan.score -= Math.abs(lane - this.lane) * (this.commit > 0 ? 2.5 : 0.35);
      // switchCost: a new lane (more than a metre from the one held) must beat it by this many metres, so near-tied
      // lanes under a noisy forecast do not trade places frame to frame.
      if (o.switchCost && Math.abs(lane - this.lane) > 1) plan.score -= o.switchCost;
      if (!best || plan.score > best.score) best = plan;
      if (o.debug) (this.dbg ??= []).push(lane.toFixed(1) + ':' + plan.score.toFixed(1));
    }
    if (sm) for (const k of sm.keys()) if (!seen.has(k)) sm.delete(k);
    if (o.debug) { this.dbgLine = (free ? 'F' : 'k' + (kNow * 1000).toFixed(0)) + ' r' + near.map((r) => (reach(r) ? 1 : 0) + '/' + (base?.closest.get(r) ?? 0).toFixed(1)).join() + ' ' + this.dbg.join(' '); this.dbg = []; }
    // Lateral discipline: never close the door on a car that is alongside, or nearly. Move toward it only while a
    // clear gap remains; when the gap is already tight, hold the present offset and let the other car decide.
    let lane = best.lane;
    for (const r of near) {
      if (Math.abs(r.gap) > NOSE + 3) continue;
      const side = Math.sign(r.e - loc.e) || 1, room = Math.abs(r.e - loc.e);
      const limit = room < SIDE + 0.2 ? loc.e : r.e - side * (SIDE + 0.2);
      lane = side > 0 ? Math.min(lane, limit) : Math.max(lane, limit);
    }
    best.lane = lane;
    if (Math.abs(best.lane - this.lane) > 1.2) this.commit = o.commit ?? 0.7;
    this.lane = best.lane; this.plan = best;

    // Speed: never closer than a safe following distance to anything in the corridor the car is actually in.
    const cap = this.follow(car, near, loc.e, v, best);
    this.target = best.focus ? { id: best.focus.car.id, gap: best.focus.gap } : null;
    return { lateral: best.lane, cap, mode: best.mode, laneRate: best.mode === 'ATTACK' || best.mode === 'DEFEND' ? 4.2 : 3.2 };
  }

  /** Drive one lane for the horizon against every rival's forecast. Score is metres made good, plus position terms. */
  drive(car, near, loc, v, grip, lane, mark = null, beside = null) {
    const line = this.line, len = line.n * line.ds, env = envelope(car.classId);
    let s = 0, e = loc.e, u = v, score = 0, blocked = null, blockedT = Infinity, mode = 'PACE', feasible = true;
    const pf = this.o.pathForecast ?? true, tau = this.o.devTau ?? 1.2, Y = this.o.yieldOverlap ?? 0;
    // Lateral forecast: the rival's own path (learnt; the racing line until it is), plus its present deviation from
    // that path decaying over tau: a car off its line is going back to it, not drifting on forever.
    // fcHold: the rival keeps the offset it has now (plus its lateral speed run out over fcHold seconds, 0 = none).
    // Measured on the benches (fcAudit), a car's offset from the line is a far better forecast of where it is 1-2 s on
    // than its remembered path: 0.2-1.2 m off at 1 s against 2.1 m (a car in traffic is not on its line, and an unknown
    // path is the racing line, which a car defending or passing is not going back to).
    const prior = (r, i) => (Number.isNaN(r.path[i]) ? 0 : r.path[i]);
    const rs = near.map((r) => ({ r, s: r.gap, e: r.e, u: r.car.speed, dev: r.e - prior(r, r.hint), close: Math.abs(r.gap), lat: Infinity }));
    // mark: a time (s) at which every rival's place relative to ORACLE is written down (the braking point of a move).
    const atMark = mark != null ? new Map() : null, H = this.o.horizon ?? HORIZON, tMark = mark != null ? Math.max(STEP, Math.min(mark, H)) : Infinity;
    // Debugger trails: ORACLE's own forecast [s, e, u, wake] and every rival's [s, e], plus the first forecast overlap.
    const trail = this.recording ? [[0, e, u, 0]] : null; let contact = null;
    if (trail) for (const x of rs) x.tr = [[x.s, x.e]];
    // beside: a move's lane is a side of the rival that only ever steps away from it: a car's width outside the furthest
    // the rival has come to that side (beside.edge, since the move began) or is forecast to come before ORACLE is clear
    // of it. The lane never follows the rival back, so a move is one steady line, and a rival drifting across is met
    // where the forecast saw it coming. The driven move keeps the same edge, so the move judged is the move driven.
    const bx = beside ? rs.find((x) => x.r === beside.r) : null, maxL = this.o.maxLane ?? 7, LV = beside?.late ? line.late(beside.late).v : line.v;
    let edge = beside?.edge ?? bx?.e ?? 0;
    for (let t = STEP; t <= H + 1e-9; t += STEP) {
      const [i, f] = at2(line, loc.s + s);
      // planMoveRate: a move's lane is forecast at the rate the driver moves it (the move lane rate), not the line's.
      const rate = (bx && this.o.planMoveRate ? this.o.planMoveRate : 3.4) * (this.o.laneV0 !== 0 ? Math.min(1, (this.o.laneV0 ?? 40) / Math.max(1, u)) : 1);
      // edgeRelax: the furthest the rival came is let go back toward where it is at this rate (m/s), so a rival that
      // drifted out and came back does not leave ORACLE a lane width wide into the corner (the inside of a turn on a
      // radius far tighter than the line's); slower than any weave, so the move is still one steady line.
      const er = (this.o.edgeRelax ?? 0) * STEP;
      if (bx && bx.s - s > -NOSE) edge = beside.side > 0 ? Math.max(edge - er, bx.e) : Math.min(edge + er, bx.e);
      const tl = bx ? clamp(edge + beside.side * (SIDE + beside.gap), -maxL, maxL) : lane;
      e += clamp(line.offset(i, f, 0, tl) - e, -rate * STEP, rate * STEP);
      // Off the line: the turn's radius changes by the offset (corner speed ∝ √R) and so does the path length.
      const k = line.sample(line.k, i, f), shrink = Math.max(0.35, 1 + k * e);   // k > 0 turns left, e > 0 is right: + is the outside of a left turn
      // The line already spends the road's width on the turn, so leaving it never pays by itself: the inside is a tighter
      // radius (slower), the outside a longer way round (concentric circles would credit the inside with a shortcut
      // the real car cannot drive). Only a tow, a pass or a defence can make an off-line lane worth its cost.
      // planLF: the corner limit of the lane as the driver will drive it (its own clamped path's curvature, the road edge
      // included), so the lane that is scored is the lane that is driven.
      let vmax = line.sample(LV, i, f) * grip * (this.o.planLF !== false && Math.abs(e) > 0.3 ? Math.min(Math.sqrt(Math.min(1, shrink)), line.laneFactor(i, f, 0, e)) : this.o.laneShortcut ? Math.sqrt(shrink) : Math.sqrt(Math.min(1, shrink)));
      // Slipstream: the wake of a rival just ahead in this lane cuts drag the same way the physics does, and costs
      // downforce (16% at full wake) and so corner speed.
      let wake = 0;
      for (const x of rs) { const b = x.s - s; if (b > 1.5 && b < 110) { const cone = 2.4 + b * 0.05, d = Math.abs(x.e - e); if (d < cone) wake = Math.max(wake, Math.exp(-b / 55) * (1 - (d / cone) ** 2)); } }
      if (wake && !this.o.noWakeGrip) vmax *= Math.sqrt(1 - 0.16 * wake * downforceShare(env, vmax));
      const drag = 0.5 * 1.225 * car.spec.area * car.spec.cd * u * u / car.spec.mass;
      // Drive gets what the corner leaves of the tyres (friction ellipse on this lane's own curvature).
      const use = this.o.planEllipse === false ? 0 : Math.min(1, u * u * Math.abs(k) / Math.max(0.6, shrink) / Math.max(1, at(env.lat, u) * grip * grip));
      const acc = at(env.accel, u) * Math.sqrt(Math.max(0.1, 1 - use * use)) + drag * 0.42 * wake;
      u = Math.min(u + acc * STEP, Math.max(vmax, u - at(env.brake, u) * 0.9 * STEP));
      // Rivals move on their own forecast: pedals now, then their own pace on ORACLE's profile.
      for (const x of rs) {
        // velFloor: a station's remembered speed is blended over laps, so one lap the rival spent stuck or fighting leaves
        // it slow there for several more; it is never taken below this share of the pace its ratio gives on the line.
        const [ri, rf] = at2(line, loc.s + x.s), known = pf && !Number.isNaN(x.r.vel[ri]), pace = line.sample(line.v, ri, rf) * x.r.ratio;
        const rv = known ? (this.o.velFloor ? Math.max(x.r.vel[ri], pace * this.o.velFloor) : x.r.vel[ri]) : pace;
        if (this.o.rivalPhys) {
          // rivalPhys: the rival does what its pedals say now, handing over within half a second to what its pace asks:
          // toward its speed here at no more than its car can accelerate, down to it no harder than it can brake.
          const w = Math.exp(-t * 2), up = at(x.r.env.accel, x.u), dn = at(x.r.env.brake, x.u);
          const want = clamp((rv - x.u) / STEP, -dn, up);
          x.u = Math.max(0, x.u + (w * x.r.acc + (1 - w) * want) * STEP);
        } else x.u = Math.max(0, Math.min(x.u + x.r.acc * STEP * Math.exp(-t * 1.5) + (rv - x.u) * Math.min(1, STEP * 1.2 * (1 - Math.exp(-t * 1.5))), Math.max(rv, x.u - at(x.r.env.brake, x.u) * STEP)));
        x.s += x.u * STEP; x.close = Math.min(x.close, Math.abs(x.s - s));
        if (t <= (this.o.squeezeT ?? 1) && Math.abs(x.s - s) < NOSE + 1) x.lat = Math.min(x.lat, Math.abs(x.e - e));
        if (this.o.fcHold != null) { if (this.o.fcHold > 0) x.e += x.r.edot * STEP * Math.exp(-t / this.o.fcHold); }
        else if (pf) { x.dev *= Math.exp(-STEP / tau); const [pi] = at2(line, loc.s + x.s); x.e = prior(x.r, pi) + x.dev; }
        else x.e += x.r.edot * STEP * Math.exp(-t / 0.6);
        x.e = clamp(x.e, line.sample(line.lo, ri, rf) - line.sample(line.w, ri, rf), line.sample(line.hi, ri, rf) - line.sample(line.w, ri, rf));
        // Room: a rival ORACLE is overlapping leaves a car's width (the rules' due to a car alongside), so its forecast
        // path is pushed wide of ORACLE's, and its speed goes with the corner limit of that wider path.
        if (Y && Math.abs(x.s - s) < NOSE * Y && Math.abs(x.e - e) < SIDE) {
          const side = Math.sign(x.e - e) || 1, want = e + side * SIDE, lo = line.sample(line.lo, ri, rf) - line.sample(line.w, ri, rf), hi = line.sample(line.hi, ri, rf) - line.sample(line.w, ri, rf);
          const pushed = clamp(want, lo, hi), was = x.e; x.e = pushed;
          if (Math.abs(pushed - was) > 0.3) x.u = Math.min(x.u, rv * line.laneFactor(ri, rf, 0, pushed) / Math.max(0.55, line.laneFactor(ri, rf, 0, was)));
        }
      }
      // Contacts: a rival ahead in this lane makes ORACLE follow; one alongside in the same space rules the lane out.
      // Progress is along the line: the outside of a turn is a longer road for the same speed.
      let next = s + u * STEP / (this.o.laneShortcut ? Math.max(0.6, shrink) : Math.max(1, shrink));
      // planReact: the headway (s) the forecast follows a car at. The driver closes to a nose and a car-length margin
      // in a tow (towReact) while the car ahead is not braking; the forecast keeps 0.12 s unless this says otherwise,
      // which on a straight held the forecast car at the rival's speed from 12 m back through a pull-out.
      const hw = (this.o.planReact != null) ? this.o.planReact : 0.12;
      for (const x of rs) {
        const ds = x.s - next, de = Math.abs(x.e - e);
        if (de < SIDE && x.s > s && ds < NOSE + u * hw) { u = Math.min(u, x.u); next = Math.max(s, Math.min(next, x.s - NOSE)); if (!blocked) { blocked = x.r; blockedT = t; } }
        if (de < SIDE - 0.25 && Math.abs(x.s - next) < NOSE - 0.3 && t < 1.6) feasible = false;
        // sideRoom: a move is a side of the road with room for the car beside every rival it meets, for the whole
        // horizon: one that leaves ORACLE closer than the lane discipline's car width plus margin (the road running out
        // under the side lane, a third car) is a squeeze, not a move.
        else if (beside && this.o.sideRoom && de < SIDE && Math.abs(x.s - next) < NOSE - 0.3) feasible = false;
      }
      s = next;
      if (atMark && !atMark.size && t >= tMark - 1e-9) for (const x of rs) atMark.set(x.r, { rel: x.s - s, de: x.e - e, du: u - x.u });
      if (trail) {
        trail.push([s, e, u, wake]);
        for (const x of rs) {
          x.tr.push([x.s, x.e]);
          if (!contact && Math.abs(x.s - s) < NOSE && Math.abs(x.e - e) < SIDE - 0.25) contact = { t: +t.toFixed(1), s, e, r: x.r, closing: +Math.abs(u - x.u).toFixed(1) };
        }
      }
    }
    score = s - Math.abs(e) * 0.4;
    // Position terms, decided at the end of the horizon.
    let focus = null;
    for (const x of rs) {
      const was = x.r.gap, now = x.s - s;
      if (was > 0 && now < -1) { score += this.o.passBonus ?? 9; mode = 'ATTACK'; focus = x.r; }
      if (was < 0 && now > 1) score -= this.o.loseCost ?? 9;
      if (Math.abs(now) < NOSE && Math.abs(x.e - e) < SIDE + 1) {
        // Ending alongside: the inside of the next turn holds the corner, the outside gets squeezed.
        const [i, f] = at2(line, loc.s + s + 40), k = line.sample(line.k, i, f);
        score -= Math.sign(k) * Math.sign(e - x.e) * Math.min(1, Math.abs(k) * 60) * (this.o.insideBonus ?? 8);
        if (mode === 'PACE') { mode = 'BATTLE'; focus = x.r; }
      }
    }
    // Defence: a rival behind and closing makes the open inside of the next turn cost something.
    for (const x of rs) {
      const r = x.r;
      if (r.gap < -1 && r.gap > -30 && r.car.speed > v - 1 && r.env.top <= envelope(car.classId).top + 1) {
        const [i, f] = at2(line, loc.s + 90), k = line.sample(line.k, i, f);
        if (Math.abs(k) > 0.008) {
          const at90 = line.offset(i, f, 0, lane), inside = Math.sign(k) > 0 ? at90 - (line.sample(line.lo, i, f) - line.sample(line.w, i, f)) : line.sample(line.hi, i, f) - line.sample(line.w, i, f) - at90;
          const open = Math.max(0, inside - SIDE);
          score -= open * (this.o.defend ?? 0.9) * (1 - Math.abs(r.gap) / 30);
          if (mode === 'PACE' && open < 1) { mode = 'DEFEND'; focus = r; }
        }
      }
      // A faster class closing from behind is let by: running in its path costs.
      if (r.gap < 0 && r.gap > -60 && r.env.top > envelope(car.classId).top + 3 && Math.abs(r.e - lane) < SIDE + 0.5) score -= 6;
    }
    if (blocked && mode === 'PACE') { mode = 'FOLLOW'; focus = blocked; }
    if (!feasible) score -= 1000;
    return { lane, score, mode, focus, blocked, blockedT, atMark, feasible, trail, contact, rtr: trail ? new Map(rs.map((x) => [x.r, x.tr])) : null, closest: new Map(rs.map((x) => [x.r, x.close])), squeeze: new Map(rs.map((x) => [x.r, x.lat])) };
  }

  /**
   * Committed moves. Racecraft as a small set of moves the car commits to, each judged on the same forecast:
   *   LINE  - the racing line, in the tow of whatever is ahead (the follow cap keeps the distance).
   *   MOVE  - one side of the car ahead: a pull-out in the last seconds before a braking point (the slingshot), or a
   *           dive up the inside in the braking zone. Taken only when the forecast puts ORACLE alongside by the braking
   *           point (or past) for a real gain over staying in line; then held, the lane tracking the rival's side,
   *           until the pass is done or the forecast has clearly failed for a moment (then back into line, behind).
   *   COVER - (option) one move to the inside before a braking zone when a car behind is closing: never a weave, never
   *           a lift.
   * Nothing is re-decided frame to frame: a move is chosen, held, and finished or dropped.
   */
  moves(car, near, loc, v, grip, dt, free) {
    const o = this.o, line = this.line, max = o.maxLane ?? 7, myTop = envelope(car.classId).top;
    const st = (this.mv ??= { kind: 'LINE', side: 0, id: null, bad: 0, cool: 0, covered: null, n: { start: 0, done: 0, drop: 0, lost: 0 } });
    st.cool = Math.max(0, st.cool - dt); this.clock = (this.clock ?? 0) + dt;
    const J = this.recording ? [] : null;
    // The next braking point on the line, and which way the turn after it goes (k > 0 turns left; + is right).
    let db = Infinity;
    for (let d = 0; d < 400; d += 5) if (line.sample(line.vb, loc.i, loc.f, d) < v - 3) { db = d; break; }
    let km = 0, da = db;
    for (let d = Number.isFinite(db) ? db : 0, end = d + 90; d < end; d += 5) { const k = line.sample(line.k, loc.i, loc.f, d); if (Math.abs(k) > Math.abs(km)) { km = k; da = d; } }
    const inside = -Math.sign(km) || 1, tb = db / Math.max(10, v);
    this.dbNow = db;
    // diveApex: a dive wins its overlap in the braking zone, so it is judged at the apex (the time to it on the line's
    // speeds), not at the braking point.
    const tA = o.diveApex && Number.isFinite(db) ? tb + (da - db) / Math.max(8, (line.sample(line.vb, loc.i, loc.f, db) + line.sample(line.vb, loc.i, loc.f, da)) / 2) : tb;
    const base = this.drive(car, near, loc, v, grip, 0, tb);
    this.wide = db < (o.wideD ?? 40) || this.inCorner ? { inside } : null;
    const sideLane = (r, side, gap = o.moveGap ?? 0.4) => clamp(r.e + side * (SIDE + gap), -max, max);
    // wideGap: a move is judged on two lanes each side, a car's width plus the tight gap and plus this wider one, so
    // the road's width is used when it pays (a rival that wanders, a wake to leave, room to brake beside it).
    const gaps = o.wideGap ? [o.moveGap ?? 0.4, o.wideGap] : [o.moveGap ?? 0.4];
    // A move is good when the forecast has ORACLE overlapping the rival (its nose at least this share of a car up the
    // rival's side) by the braking point: a pass that only comes after the corner is a guess, not a move. With no
    // braking point inside the horizon, a pass by its end counts. Held moves get more slack than new ones.
    const judge = (r, side, need, mark = tb, gap = undefined, edge = r.e) => {
      const late = o.lateBrake && side === inside ? o.lateBrake : 0;
      const p = this.drive(car, near, loc, v, grip, sideLane(r, side, gap), mark, o.besideLane ? { r, side, gap: gap ?? o.moveGap ?? 0.4, edge, late } : null), m = p.atMark?.get(r);
      // markRule: with the braking point beyond the horizon the move is judged where the horizon ends, on the same
      // overlap test (the rival's place relative to ORACLE then), for starting and for holding alike.
      const passed = !o.markRule && mark > (o.horizon ?? HORIZON) && r.gap > 0 && p.focus === r && p.mode === 'ATTACK';
      // markExtrap: a braking point beyond the horizon is reached at the closing speed the forecast ends with, so a pass
      // still closing at the end of the horizon is judged where it will be at the brake (no braking point within reach:
      // markMax seconds on), not given up because a slower car takes longer than the horizon to draw alongside.
      const H = o.horizon ?? HORIZON, rel = m == null ? null : o.markExtrap && mark > H ? m.rel - Math.max(0, m.du) * (Math.min(mark, o.markMax ?? 7) - H) : m.rel;
      const j = { p, gain: p.score - Math.max(base.score, p.score - 50), ok: p.feasible && (passed || (rel != null && rel < NOSE * need)) };
      if (J) J.push({ r, side, need, mark, gap, rel: m?.rel ?? null, ...j });
      return j;
    };
    let T = st.id != null ? near.find((r) => r.car.id === st.id) : null;
    if (st.kind === 'MOVE' && (!T || T.gap < -(NOSE + 2) || T.gap > 80)) { this.note(`${T && T.gap < 0 ? '▲ PASS done' : '▼ move lost'} #${st.id}`); if (o.mvLog) st.ev.push(`END ${T && T.gap < 0 ? 'done' : 'lost'} s${loc.s.toFixed(0)}`); st.n[T && T.gap < 0 ? 'done' : 'lost']++; st.kind = 'LINE'; st.id = null; T = null; }
    const alongside = (r) => Math.abs(r.gap) < NOSE + 1;
    this.whyNot = null; this.prospect = null;
    if (st.kind === 'LINE' && !st.cool) {
      // The car ahead, close enough for a move and not already alongside.
      const r = near.filter((x) => x.gap > NOSE * 0.6 && x.gap < 40 && x.env.top <= myTop + 3).sort((a, b) => a.gap - b.gap)[0];
      if (r) {
        const sides = [];
        // Slingshot: out of the tow in the last seconds before the brake (earlier gives the tow away for nothing).
        let dive = false, early = false;
        // pullClose: a car already closing by this much (m/s) has no tow to give away, so it pulls out as soon as the
        // forecast has it alongside by the braking point, wherever on the straight that is: held to the slingshot's last
        // seconds, the follow cap bled the speed off first (from 20-40 m back) and the pull-out came with none left.
        const closing = o.pullClose != null && v - r.car.speed > o.pullClose;
        if (free && r.gap < (closing ? o.pullCloseGap ?? 40 : o.pullGap ?? 25) && (tb < (o.pullT ?? 3) || closing)) sides.push(inside, -inside);
        // Dive: up the inside in the braking zone, close behind.
        else if (db < (o.diveD ?? 30) && r.gap < (o.diveGap ?? 12)) { sides.push(inside); dive = true; }
        // earlyPass: a car too slow to tow behind is passed on the straight, wherever the straight starts. The forecast
        // must have ORACLE clear ahead of it by the braking point (or past it by the end of the horizon when the brake is
        // further off), which a car of equal pace never allows: there the tow and the slingshot stay the move.
        // towFirst: only a car already closing by this much (m/s) is passed early; at the rival's own speed, out of a
        // corner above all, ORACLE sits in its tow, where the wake builds the speed the slingshot then spends before the
        // brake (a pull-out without that speed gives the tow away and hangs alongside).
        else if (o.earlyPass && free && !(o.towFirst != null && v - r.car.speed < o.towFirst)) { sides.push(inside, -inside); early = true; }
        let best = null, why = !sides.length ? (free ? (r.gap >= (o.pullGap ?? 25) ? 'far' : 'early') : 'corner') : null;
        // sidePick: the gain is capped (a move is worth starting or not), so against a slower car both sides reach the cap
        // and the first one judged, the inside, always won. The side is chosen on the whole forecast instead, plus this
        // many metres per metre of road left clear beside the lane where the pass is made (the rival's flank to the edge
        // over the 60 m from it, less the lane's width and gap: up to two metres of clear air counts, a squeezed lane
        // costs): an open road on one side is taken over a door left ajar on the other.
        const spare = (side, gap) => {
          let m = Infinity;
          for (let d = Math.max(0, r.gap); d <= r.gap + 60; d += 10) {
            const w = line.sample(line.w, loc.i, loc.f, d), edge = side > 0 ? line.sample(line.hi, loc.i, loc.f, d) - w - r.e : r.e - line.sample(line.lo, loc.i, loc.f, d) + w;
            m = Math.min(m, edge - HALF_W - (SIDE + gap));
          }
          return clamp(m, -1.5, 2);
        };
        const key = (j, side, gap) => (o.sidePick ? j.p.score + o.sidePick * spare(side, gap) : j.gain);
        const tried = o.mvLog ? [] : null;
        for (const side of sides) for (const gap of gaps) {
          // pullApex: a slingshot to the inside is judged where the move it starts is held, at the apex (alongside there
          // owns the corner, and the later braking of the inside lane is how a car of equal pace gets there), not half
          // alongside already at the braking point, which only a far faster car reaches out of a tow.
          // earlyIn: a pass on the straight up the inside of the coming turn needs only this much overlap by the braking
          // point (a car alongside on the inside there owns the corner, the rival must leave it room: yieldOverlap), not
          // the clear lead the outside needs.
          const need = early ? (o.earlyIn != null && side === inside ? o.earlyIn : o.earlyNeed ?? -0.3) : o.overlap ?? 0.5;
          const j = judge(r, side, need, dive || (o.pullApex && !early && side === inside) ? tA : tb, gap);
          if (tried) { const m = j.p.atMark?.get(r); tried.push(`${side > 0 ? 'R' : 'L'}${gap} ok${j.ok ? 1 : 0} f${j.p.feasible ? 1 : 0} g${j.gain.toFixed(1)} sc${j.p.score.toFixed(0)} rel${m ? m.rel.toFixed(1) : '-'} sp${spare(side, gap).toFixed(1)}`); }
          if (j.ok && j.gain > (o.startGain ?? 2)) { const k = key(j, side, gap); if (!best || k > best.k) best = { ...j, side, gap, k }; }
          why ??= !j.p.feasible ? 'infeasible' : !j.ok ? 'noOverlap' : j.gain <= (o.startGain ?? 2) ? 'noGain' : null;
        }
        if (early && !best && why) why = 'slowNo' + why[0].toUpperCase() + why.slice(1);
        if (!best && why && r.gap < 15) st.n[why] = +((st.n[why] ?? 0) + dt).toFixed(2);
        if (((o.mvLog === 2 && r.gap < 15) || (o.mvLog === 3 && v - r.car.speed > 3)) && !best && (this.clock ?? 0) - (st.nopeT ?? -9) > 0.5) { st.nopeT = this.clock ?? 0; (st.ev ??= []).push(`NOPE t${(this.clock ?? 0).toFixed(1)} s${loc.s.toFixed(0)} ${why} gap${r.gap.toFixed(1)} v${v.toFixed(1)}/${r.car.speed.toFixed(1)} tb${tb.toFixed(2)} tA${tA.toFixed(2)} in${inside} base${base.score.toFixed(0)} | ${tried.join(' | ')}`); }
        this.whyNot = best ? null : why; this.prospect = r;
        // cramped: a move started into a side with no clear road (squeezed to the edge) while the other side had a metre
        // or more (counted for the benches).
        if (best && sides.length > 1 && spare(best.side, best.gap) < 0 && spare(-best.side, gaps[0]) > 1) { st.n.cramped = (st.n.cramped ?? 0) + 1; if (tried) (st.ev ??= []).push(`CRAMP s${loc.s.toFixed(0)} gap${r.gap.toFixed(1)} re${r.e.toFixed(1)} e${loc.e.toFixed(1)} tb${tb.toFixed(1)} ${dive ? 'dive' : early ? 'early' : 'pull'} in${inside} | ${tried.join(' | ')}`); }
        if (best) { if (o.mvLog) (st.ev ??= []).push(`START ${st.n.start} s${loc.s.toFixed(0)} gap${r.gap.toFixed(1)} v${v.toFixed(1)}/${r.car.speed.toFixed(1)} tb${tb.toFixed(2)} side${best.side} in${inside} gain${best.gain.toFixed(1)} rel${best.p.atMark?.get(r)?.rel.toFixed(1)} free${free} e${loc.e.toFixed(1)} re${r.e.toFixed(1)}${tried ? ' | ' + tried.join(' | ') : ''}`); st.n.start++; this.note(`${dive ? 'DIVE' : early ? 'PASS' : 'PULL-OUT'} ${best.side === inside ? 'inside' : 'outside'}${best.gap > (o.moveGap ?? 0.4) ? ' wide' : ''} on #${r.car.id} · gap ${r.gap.toFixed(1)} m · +${best.gain.toFixed(1)} m`); st.kind = 'MOVE'; st.dive = dive; st.early = early; st.side = best.side; st.gap = best.gap; st.edge = r.e; st.id = r.car.id; st.bad = 0; T = r; }
      }
    }
    let lane = 0, mode = 'PACE', focus = null;
    if (st.kind === 'MOVE') {
      const er = (o.edgeRelax ?? 0) * dt;
      if (T.gap > -NOSE) st.edge = st.side > 0 ? Math.max((st.edge ?? T.e) - er, T.e) : Math.min((st.edge ?? T.e) + er, T.e);
      const j = judge(T, st.side, o.overlapKeep ?? 1, st.dive || (o.diveApex && st.side === inside) ? tA : tb, st.gap, st.edge);
      // Dropped only when it has clearly failed for a moment: infeasible, or not getting alongside and costing time.
      // Alongside, the move is held: the car beside is given its room (lateral discipline) and leaned on if it squeezes,
      // never backed out of mid-overlap.
      st.bad = !alongside(T) && T.gap > 0 && (!j.p.feasible || !j.ok || j.gain < -(o.abortGain ?? 3)) ? st.bad + dt : 0;
      if (st.bad > (o.abortT ?? 0.3)) { if (o.mvLog) st.ev.push(`DROP s${loc.s.toFixed(0)} gap${T.gap.toFixed(1)} v${v.toFixed(1)}/${T.car.speed.toFixed(1)} tb${tb.toFixed(2)} feas${j.p.feasible} ok${j.ok} gain${j.gain.toFixed(1)} rel${j.p.atMark?.get(T)?.rel.toFixed(1)} e${loc.e.toFixed(1)} re${T.e.toFixed(1)}`); st.n.drop++; this.note(`✕ DROP on #${T.car.id} · ${!j.p.feasible ? 'no room' : !j.ok ? 'no overlap' : 'costs time'}`); st.kind = 'LINE'; st.id = null; st.cool = o.cool ?? 1; }
      else { lane = o.besideLane ? clamp(st.edge + st.side * (SIDE + (st.gap ?? o.moveGap ?? 0.4)), -max, max) : sideLane(T, st.side, st.gap); mode = alongside(T) ? 'BATTLE' : 'ATTACK'; focus = T; }
    }
    // Cover: one move to the inside before the braking zone against a car closing from behind.
    if (st.kind === 'LINE' && o.cover) {
      const key = Number.isFinite(db) ? Math.round((loc.s + db) / 50) : null;
      const r = near.find((x) => x.gap < -NOSE * 0.6 && x.gap > -15 && x.car.speed > v + 0.5 && x.env.top <= myTop + 1);
      if (free && key != null && r && tb < (o.coverT ?? 2) && st.covered == null) st.covered = key;
      if (st.covered != null && st.covered === key && db > 0) { lane = inside * o.cover; mode = 'DEFEND'; focus = r ?? null; }
      else if (st.covered != null && st.covered !== key) st.covered = null;
    }
    // coverRoom: one move before a braking zone against a car behind that can get its nose alongside by it (the forecast
    // has it within coverReach of ORACLE's tail at the braking point, or it is close and closing now: the forecast
    // gives it no tow). The inside of the corner's entry is taken toward the point where no car fits between ORACLE
    // and the edge (ORACLE's centre this far from it), no more than coverMax off the line and only when the forecast
    // prices the tighter entry under coverCost metres; made on the straight before the car behind is alongside (the
    // lane discipline below never closes on a car beside), held through the braking to the apex, then the line again.
    // One move per corner, never a weave, never a lift: a line already that tight is not moved.
    if (st.kind === 'LINE' && o.coverRoom) {
      const len = line.n * line.ds, ahead = (x) => wrap(x - loc.s + len / 2, len) - len / 2;
      if (st.cv && ahead(st.cv.a) < -5) st.cv = null;
      if (!st.cv && free && Number.isFinite(db) && tb < (o.coverT ?? 2.5)) {
        const r = near.find((x) => x.gap < -NOSE * 0.6 && x.gap > -25 && x.env.top <= myTop + 1
          && ((base.atMark?.get(x)?.rel ?? -Infinity) > -(NOSE + (o.coverReach ?? 1.5)) || (x.gap > -(o.coverGap ?? 8) && x.car.speed > v + 0.3)));
        if (r) {
          const w = line.sample(line.w, loc.i, loc.f, db), edge = (inside > 0 ? line.sample(line.hi, loc.i, loc.f, db) : line.sample(line.lo, loc.i, loc.f, db)) - w;
          const cl = clamp(edge - inside * o.coverRoom, -(o.coverMax ?? 2.5), o.coverMax ?? 2.5), rate = 3.2 * Math.min(1, 40 / Math.max(1, v));
          if (cl * inside <= 0.3) st.cv = { a: loc.s + da, lane: 0, id: r.car.id };
          else if (tb > Math.abs(cl) / rate * 0.7 && this.drive(car, near, loc, v, grip, cl).score > base.score - (o.coverCost ?? 6)) {
            st.cv = { a: loc.s + da, lane: cl, id: r.car.id }; st.n.cover = (st.n.cover ?? 0) + 1;
            if (o.mvLog) (st.ev ??= []).push(`COVER s${loc.s.toFixed(0)} gap${r.gap.toFixed(1)} lane${cl.toFixed(1)} tb${tb.toFixed(2)}`);
            this.note(`◆ COVER inside on #${r.car.id} · ${Math.abs(cl).toFixed(1)} m`);
          }
        }
      }
      if (st.cv) { lane = st.cv.lane; mode = 'DEFEND'; focus = near.find((x) => x.car.id === st.cv.id) ?? null; }
    }
    // A faster class closing from behind is let by: hold the line, it passes where it likes.
    // Lateral discipline: never close the door on a car alongside.
    // sideGap: side by side, the lane keeps this much clear air beyond a car's width from the car beside, measured from
    // where it is and where it is drifting (half a second of its lateral speed toward ORACLE), and steps away from it
    // when the gap has closed (the path gives the room, at the lane rate, never the brakes). At the limit a car runs
    // up to a metre off the lane it is asked for, so the clear air is that margin; where the road runs out the lane
    // stops at the edge and the gap is what is left. It is the overlap's margin: it fades out over the two metres
    // past nose-to-tail, so a car just ahead or behind does not hold ORACLE off its line into the next braking zone.
    for (const r of near) {
      if (Math.abs(r.gap) > NOSE + 3) continue;
      const side = Math.sign(r.e - loc.e) || 1, room = Math.abs(r.e - loc.e);
      let limit;
      if (o.sideGap != null) {
        const w = clamp((NOSE + 2 - Math.abs(r.gap)) / 2, 0, 1), toward = Math.max(0, -side * r.edot) * 0.5;
        limit = r.e - side * (SIDE + 0.2 + w * (o.sideGap - 0.2 + toward));
      }
      else limit = room < SIDE + 0.2 ? loc.e : r.e - side * (SIDE + 0.2);
      lane = side > 0 ? Math.min(lane, limit) : Math.max(lane, limit);
    }
    this.lane = lane;
    const cap = this.follow(car, near, loc.e, v, { lane, blocked: null, blockedT: Infinity, loc });
    if (mode === 'PACE' && this.capBy && cap < v + 2) { mode = 'FOLLOW'; focus = this.capBy.r; }
    if (J) {
      // Preview for the debugger: with no move judged this frame, the two sides of the car ahead as a move would see them.
      const r = this.prospect ?? near.filter((x) => x.gap > NOSE * 0.6 && x.gap < 40).sort((a, b) => a.gap - b.gap)[0];
      const real = J.length, held = st.kind === 'MOVE' ? J.at(-1) : null;
      if (!real && r) for (const side of [inside, -inside]) judge(r, side, o.overlap ?? 0.5, tb, gaps[0]);
      this.vis = { db, da, tb, tA, inside, free, base, cands: J.map((q, k) => ({ ...q, preview: k >= real, chosen: q === held })), held: Boolean(held), lane, cap, wide: this.wide,
        kind: st.kind, side: st.side, id: st.id, dive: Boolean(st.dive), bad: st.bad, cool: st.cool, n: { ...st.n }, whyNot: this.whyNot, mode, focus };
    } else this.vis = null;
    this.plan = { lane, mode, focus, score: base.score }; this.target = focus ? { id: focus.car.id, gap: focus.gap } : null;
    if (o.debug) this.dbgLine = `${st.kind}${st.side && st.kind === 'MOVE' ? (st.side > 0 ? 'R' : 'L') : ''} db${Number.isFinite(db) ? db : '-'} in${inside > 0 ? 'R' : 'L'} bad${st.bad.toFixed(2)}`;
    // lateBrake: a move up the inside brakes on the late profile (the braking this many times harder), as it was judged.
    const late = o.lateBrake && st.kind === 'MOVE' && st.side === inside && focus ? o.lateBrake : 0;
    return { lateral: lane, cap, mode, laneRate: st.kind === 'MOVE' ? 4.2 : 3.2, late };
  }

  /** Safe following speed: stop short of every rival in the car's own corridor if it brakes as hard as it can. */
  follow(car, near, e, v, plan) {
    const mine = at(envelope(car.classId).brake, v) * (this.o.followBrake ?? 1);
    let cap = Infinity; this.capBy = null;
    for (const r of near) {
      if (r.gap <= 0) continue;
      // capReach: the lane is where the road lets the car be when it gets to the rival (a side lane past the edge of the
      // road is driven at the edge), so a move that cannot get clear of the car ahead is still held behind it.
      const lane = this.o.capReach && plan.loc ? this.line.offset(plan.loc.i, plan.loc.f, Math.max(0, r.gap), plan.lane) : plan.lane;
      // capForecast: a rival forecast to come across into the car within a second (tracking out of a corner) counts as
      // in the corridor now, so the car drops behind before the squeeze rather than meeting it.
      let lateral = Math.min(Math.abs(r.e - e), Math.abs(r.e - lane), this.o.capForecast ? plan.squeeze?.get(r) ?? Infinity : Infinity);
      // capArrive: the corridor that matters is the one the car will be in when it gets to the rival: its lane moving
      // toward the plan's at the lane rate, over the time it takes to close the gap. A car pulling out of the tow is
      // not held to the speed of the car it is leaving, nor a target lane to a car it has not reached.
      if (this.o.capArrive) {
        const tc = Math.max(0, r.gap - NOSE) / Math.max(0.5, v - r.car.speed), rate = this.o.capRate ?? 2.5;
        // capClear: the car a move is being made on is followed from where ORACLE is, not from the side lane it is heading
        // for: the lateral room is earned first, then the gap closed (a move still half behind it never runs into it).
        const go = this.o.capClear && this.mv?.kind === 'MOVE' && this.mv.id === r.car.id ? 0 : 1;
        const eAt = e + go * clamp(lane - e, -rate * tc, rate * tc), rAt = r.e + r.edot * Math.min(tc, 0.5);
        lateral = Math.abs(rAt - eAt);
      }
      // A car overlapping alongside is not followed: the lane discipline keeps the gap, and a lift beside it mid-corner
      // only unsettles the car (lift-off oversteer) without ever getting it behind.
      let tight = r.gap < NOSE ? this.o.sideLat ?? SIDE + 0.15 : SIDE + 0.15;
      // capMove: the car a move is being made on is followed only if ORACLE would really run into it: the lateral gap
      // as it is and as ORACLE's lane takes it (not the rival's sideways drift, whose noise switched the cap on and off
      // and pulsed the throttle beside it), against the cars' own width and a quarter metre. A rival drifting across
      // is answered by the side gap, the path, not by a lift.
      if (this.o.capMove && this.mv?.kind === 'MOVE' && this.mv.id === r.car.id) {
        const tc = Math.max(0, r.gap - NOSE) / Math.max(0.5, v - r.car.speed), rate = this.o.capRate ?? 2.5;
        lateral = Math.min(Math.abs(r.e - e), Math.abs(r.e - (e + clamp(lane - e, -rate * tc, rate * tc))));
        tight = 2 * HALF_W + 0.25;
      }
      // capWide: braking into a turn the car runs a little wide of its line (trail-brake understeer, ~1 m), so a car
      // on the outside of that turn is in the corridor out to this much further. Not the car a move is being made on:
      // that contact is the move's (contact-assisted) business.
      if (this.o.capWide && this.wide && Math.sign(r.e - e) === -this.wide.inside && !(this.mv?.kind === 'MOVE' && this.mv.id === r.car.id)) tight += this.o.capWide;
      // capSide: a car ORACLE already overlaps (or is within capSideLead of overlapping) with air between the bodies is
      // not one it can stop short of: the cap there only held ORACLE to the speed of the car beside it, switching on and
      // off as the lateral gap wavered about the threshold (the throttle pulsing beside a slower car). The side gap is
      // kept by the path; the cap stays for a car that is still ahead of the nose.
      if (this.o.capSide && r.gap < NOSE + (this.o.capSideLead ?? 1) && Math.abs(r.e - e) > 2 * HALF_W + 0.1) continue;
      if (lateral > tight && !(plan.blocked === r && r.gap > NOSE && plan.blockedT <= (this.o.blockT ?? Infinity))) continue;
      // towReact: on a straight behind a car that is not braking, the tow is taken closer (a braking point is seen
      // coming, not reacted to): the reaction allowance shrinks to this.
      // towSlow: the close tow only behind a car whose learnt pace is under this share of ORACLE's line, where the speed
      // ORACLE has in hand is there to be used; behind a car of its own pace it waits further back for its chance.
      const react = this.o.towReact != null && this.free && (r.car.controls?.brake ?? 0) < 0.05 && (this.o.towSlow == null || r.ratio < this.o.towSlow) ? this.o.towReact : this.o.followReact ?? 0.08;
      const theirs = at(r.env.brake, r.car.speed) * (this.o.followTheirs ?? 1), room = r.gap - NOSE - 0.6 - v * react;
      // capEscape: on a straight behind a car that is not braking and will not reach its braking point for a while, the
      // way out of a sudden stop is the side of it, not the brakes: the cap holds only once ORACLE could no longer step
      // clear of it in time (the lateral distance to a side the road has room on, at the lane rate, while the rival
      // brakes flat out and ORACLE brakes at escK of its grip as it steers). Until then the closing speed is kept for the
      // move, which the stop-short rule had bled away from 20-40 m back.
      let why = !this.o.capEscape ? 'off' : (r.car.controls?.brake ?? 0) >= 0.05 ? 'brk' : !((this.dbNow ?? Infinity) - r.gap > r.car.speed * 1.5) ? 'zone' : 'noRoom';
      if (this.o.capEscape && plan.loc && (r.car.controls?.brake ?? 0) < 0.05 && (this.dbNow ?? Infinity) - r.gap > r.car.speed * 1.5) {
        // The side lane is the one the lane planner can drive there (its own edge margin and lane limit), clear of the
        // rival's flank: a side the road has run out on is no way out.
        const line = this.line, d = Math.max(0, r.gap), maxL = this.o.maxLane ?? 7;
        let need = Infinity;
        for (const side of [-1, 1]) {
          const want = line.offset(plan.loc.i, plan.loc.f, d, clamp(r.e + side * (SIDE + 0.2), -maxL, maxL));
          if (side * (want - r.e) < SIDE + 0.1) continue;
          if (near.some((x) => x !== r && x.gap > -NOSE && x.gap < r.gap + NOSE && Math.abs(x.e - want) < SIDE)) continue;
          need = Math.min(need, Math.abs(want - e));
        }
        if (Number.isFinite(need)) {
          const t = need / ((this.o.escRate ?? 3.4) * Math.min(1, 40 / Math.max(1, v))) + (this.o.escReact ?? 0.1);
          const closeIn = (v - r.car.speed) * t + 0.5 * Math.max(0, theirs - (this.o.escK ?? 0.5) * mine) * t * t;
          if (room > closeIn + (this.o.capEscape === true ? 1 : this.o.capEscape)) continue;
          why = 'close';
        }
      }
      const c = Math.sqrt(Math.max(0, 2 * mine * (room + r.car.speed * r.car.speed / (2 * theirs))));
      let cr = this.o.capFloor != null && r.car.controls?.brake < 0.05 ? Math.max(c, r.car.speed - this.o.capFloor) : c;
      // capClose: stopping short of where the rival stops is not enough when ORACLE brakes harder than it can (a faster
      // class, a car held to a slower pace): both braking flat out, ORACLE is still closing until its speed comes down
      // to the rival's, and that closest approach comes before either has stopped. The speed now is held to what closes
      // no more than the room in that time.
      const dm = mine - theirs, vr = r.car.speed;
      if (this.o.capClose && dm > 0.3 && (cr - vr) / dm < vr / theirs) cr = Math.min(cr, vr + Math.sqrt(2 * dm * Math.max(0, room)));
      if (cr < cap) { cap = cr; this.capBy = { r, lateral, why: plan.loc ? why : 'old' }; }
    }
    return cap;
  }
}

/** Share of the cornering grip at speed v that comes from downforce (the pad's lateral limit over its low-speed one). */
export function downforceShare(env, v) { return clamp(1 - at(env.lat, 12) / Math.max(1, at(env.lat, v)), 0, 0.9); }

/** Index and fraction on the line for a distance along it. */
function at2(line, s) { const len = line.n * line.ds, x = wrap(s, len) / line.ds, i = Math.floor(x) % line.n; return [i, x - Math.floor(x)]; }
