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
  reset() { this.rivals.clear(); this.target = null; this.lane = 0; this.commit = 0; this.plan = null; }

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
    if (o.speed > 8 && o.controls?.brake < 0.05) r.ratio += (clamp(o.speed / Math.max(5, p), 0.6, 1.3) - r.ratio) * Math.min(1, dt * 0.8);
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
    const free = kNow < kc || (context.braking && kNow < kc * 2);
    // A rival is in reach when ORACLE could be alongside it within the planning horizon: a lane around a car further up
    // the road is a guess about a pass that the point-mass forecast cannot make reliably.
    // Reach from the forecast itself: staying on the line, does ORACLE close to within a car length or so of this rival
    // inside the horizon? (The instant speed difference is no guide: in a braking zone the follower is always faster.)
    const base = o.reachForecast === false ? null : this.drive(car, near, loc, v, grip, 0);
    const reach = (r) => r.gap > -25 && (base ? (base.closest.get(r) ?? Infinity) < NOSE + (o.reachMargin ?? 4) || Math.abs(r.gap) < NOSE + 3 : r.gap < (o.attackGap ?? 18) + Math.max(0, v - r.car.speed) * 2);
    const alongside = near.some((r) => Math.abs(r.gap) < NOSE + 3);
    // Mid-corner with nobody alongside, an off-line lane is eased back toward the line, never held.
    const lanes = free || alongside ? [0, this.lane] : [0, this.lane * 0.5];
    if (free) for (const r of near) if (reach(r)) for (const w of [SIDE + 0.3, SIDE + 1.1]) lanes.push(r.e + w, r.e - w);
    if (!free && alongside && Math.abs(this.lane) > 0.3) lanes.push(this.lane * 0.5);
    // holdT: a lane is not swung across the road in the last seconds before a braking zone: the car would arrive at the
    // brake with lateral speed to kill, in the corner's entry, which is where a car (in a wake above all) lets go. A
    // small trim (a metre) stays allowed.
    let hold = false;
    if (o.holdT && v > 30) for (let d = 0; d < v * o.holdT; d += 5) if (line.sample(line.vb, loc.i, loc.f, d) < v - 4) { hold = true; break; }
    if (hold && !alongside) for (let j = lanes.length - 1; j >= 0; j--) if (Math.abs(lanes[j] - this.lane) > (o.holdTrim ?? 1)) lanes.splice(j, 1);
    if (!lanes.length) lanes.push(this.lane);
    let best = null;
    for (const raw of lanes) {
      const lane = clamp(raw, -max, max), plan = this.drive(car, near, loc, v, grip, lane);
      plan.score -= Math.abs(lane - this.lane) * (this.commit > 0 ? 2.5 : 0.35);
      if (!best || plan.score > best.score) best = plan;
      if (o.debug) (this.dbg ??= []).push(lane.toFixed(1) + ':' + plan.score.toFixed(1));
    }
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
  drive(car, near, loc, v, grip, lane) {
    const line = this.line, len = line.n * line.ds, env = envelope(car.classId);
    let s = 0, e = loc.e, u = v, score = 0, blocked = null, mode = 'PACE', feasible = true;
    const pf = this.o.pathForecast ?? true, tau = this.o.devTau ?? 1.2, Y = this.o.yieldOverlap ?? 0;
    // Lateral forecast: the rival's own path (learnt; the racing line until it is), plus its present deviation from
    // that path decaying over tau: a car off its line is going back to it, not drifting on forever.
    const prior = (r, i) => (Number.isNaN(r.path[i]) ? 0 : r.path[i]);
    const rs = near.map((r) => ({ r, s: r.gap, e: r.e, u: r.car.speed, dev: r.e - prior(r, r.hint), close: Math.abs(r.gap), lat: Infinity }));
    for (let t = STEP, H = this.o.horizon ?? HORIZON; t <= H + 1e-9; t += STEP) {
      const [i, f] = at2(line, loc.s + s);
      const rate = 3.4 * (this.o.laneV0 !== 0 ? Math.min(1, (this.o.laneV0 ?? 40) / Math.max(1, u)) : 1);
      e += clamp(line.offset(i, f, 0, lane) - e, -rate * STEP, rate * STEP);
      // Off the line: the turn's radius changes by the offset (corner speed ∝ √R) and so does the path length.
      const k = line.sample(line.k, i, f), shrink = Math.max(0.35, 1 + k * e);   // k > 0 turns left, e > 0 is right: + is the outside of a left turn
      // The line already spends the road's width on the turn, so leaving it never pays by itself: the inside is a tighter
      // radius (slower), the outside a longer way round (concentric circles would credit the inside with a shortcut
      // the real car cannot drive). Only a tow, a pass or a defence can make an off-line lane worth its cost.
      // planLF: the corner limit of the lane as the driver will drive it (its own clamped path's curvature, the road edge
      // included), so the lane that is scored is the lane that is driven.
      let vmax = line.sample(line.v, i, f) * grip * (this.o.planLF !== false && Math.abs(e) > 0.3 ? Math.min(Math.sqrt(Math.min(1, shrink)), line.laneFactor(i, f, 0, e)) : this.o.laneShortcut ? Math.sqrt(shrink) : Math.sqrt(Math.min(1, shrink)));
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
        const [ri, rf] = at2(line, loc.s + x.s), known = pf && !Number.isNaN(x.r.vel[ri]), rv = known ? x.r.vel[ri] : line.sample(line.v, ri, rf) * x.r.ratio;
        x.u = Math.max(0, Math.min(x.u + x.r.acc * STEP * Math.exp(-t * 1.5) + (rv - x.u) * Math.min(1, STEP * 1.2 * (1 - Math.exp(-t * 1.5))), Math.max(rv, x.u - at(x.r.env.brake, x.u) * STEP)));
        x.s += x.u * STEP; x.close = Math.min(x.close, Math.abs(x.s - s));
        if (t <= (this.o.squeezeT ?? 1) && Math.abs(x.s - s) < NOSE + 1) x.lat = Math.min(x.lat, Math.abs(x.e - e));
        if (pf) { x.dev *= Math.exp(-STEP / tau); const [pi] = at2(line, loc.s + x.s); x.e = prior(x.r, pi) + x.dev; }
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
      for (const x of rs) {
        const ds = x.s - next, de = Math.abs(x.e - e);
        if (de < SIDE && x.s > s && ds < NOSE + u * 0.12) { u = Math.min(u, x.u); next = Math.max(s, Math.min(next, x.s - NOSE)); blocked ??= x.r; }
        if (de < SIDE - 0.25 && Math.abs(x.s - next) < NOSE - 0.3 && t < 1.6) feasible = false;
      }
      s = next;
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
    return { lane, score, mode, focus, blocked, closest: new Map(rs.map((x) => [x.r, x.close])), squeeze: new Map(rs.map((x) => [x.r, x.lat])) };
  }

  /** Safe following speed: stop short of every rival in the car's own corridor if it brakes as hard as it can. */
  follow(car, near, e, v, plan) {
    const mine = at(envelope(car.classId).brake, v) * (this.o.followBrake ?? 1);
    let cap = Infinity;
    for (const r of near) {
      if (r.gap <= 0) continue;
      // capForecast: a rival forecast to come across into the car within a second (tracking out of a corner) counts as
      // in the corridor now, so the car drops behind before the squeeze rather than meeting it.
      const lateral = Math.min(Math.abs(r.e - e), Math.abs(r.e - plan.lane), this.o.capForecast ? plan.squeeze?.get(r) ?? Infinity : Infinity);
      // A car overlapping alongside is not followed: the lane discipline keeps the gap, and a lift beside it mid-corner
      // only unsettles the car (lift-off oversteer) without ever getting it behind.
      const tight = r.gap < NOSE ? this.o.sideLat ?? SIDE + 0.15 : SIDE + 0.15;
      if (lateral > tight && !(plan.blocked === r && r.gap > NOSE)) continue;
      const theirs = at(r.env.brake, r.car.speed) * (this.o.followTheirs ?? 1), room = r.gap - NOSE - 0.6 - v * (this.o.followReact ?? 0.08);
      const c = Math.sqrt(Math.max(0, 2 * mine * (room + r.car.speed * r.car.speed / (2 * theirs))));
      cap = Math.min(cap, this.o.capFloor != null && r.car.controls?.brake < 0.05 ? Math.max(c, r.car.speed - this.o.capFloor) : c);
    }
    return cap;
  }
}

/** Share of the cornering grip at speed v that comes from downforce (the pad's lateral limit over its low-speed one). */
export function downforceShare(env, v) { return clamp(1 - at(env.lat, 12) / Math.max(1, at(env.lat, v)), 0, 0.9); }

/** Index and fraction on the line for a distance along it. */
function at2(line, s) { const len = line.n * line.ds, x = wrap(s, len) / line.ds, i = Math.floor(x) % line.n; return [i, x - Math.floor(x)]; }
