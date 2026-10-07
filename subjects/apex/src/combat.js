import { clamp } from './math.js';
import { CAR_LEN, CAR_WID } from './field.js';

const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

/**
 * Racecraft. Every cycle it builds a handful of lanes (windowed copies of the racing line shifted sideways, each with its
 * own speed profile), rolls each one forward against the predicted rivals on the same clock, and picks the lane with the
 * best outcome: distance made and position gained at the horizon, minus the price of any contact it risks. The price of
 * contact rises with closing speed (damage, tyre loss and, above the steward threshold, incident points on both cars), so a
 * nudge at nearly zero closing speed is nearly free and a hit is never worth it. The chosen lane is followed by the normal
 * tracker; a speed cap keeps the nose off whatever is ahead in the lane.
 *
 * The same planner handles every situation. With nothing to attack it chooses between following the line, holding the
 * present offset and leaning away from a car alongside; once a car ahead is within reach it adds lanes that run beside it
 * (some after a delay, to stay in its slipstream until the right moment). An incumbent lane keeps a bonus so the car does
 * not weave between near-equal options. `combatMode` "cap" turns the planner off: only the rear-end cap and the alongside
 * guard remain (the control used by the combat lab).
 */
export class Combat {
  constructor(driver) {
    this.d = driver; this.plan = null; this.nextAt = -1; this.k = new Map(); this.state = 'FREE'; this.stats = { plans: 0, passes: 0, aborts: 0, lanes: 0 };
    this.cap = Infinity; this.lastCands = []; this.side = 0; this.i0 = 0; this.pools = [[], []]; this.gen = 0; this.used = 0;
  }
  /** A lane buffer from the pool (a window is built into it in O(window)). Buffers of the previous cycle stay untouched. */
  laneBuffer() { const pool = this.pools[this.gen]; return pool[this.used] ?? (pool[this.used] = this.d.line.blankLane()), pool[this.used++]; }
  reset() { this.plan = null; this.nextAt = -1; this.k.clear(); this.state = 'FREE'; this.cap = Infinity; this.side = 0; this.focus = null; this.contact = null; this.visCands = []; this.rank?.clear(); this.events = []; this.lastAttack = -99; this.epStart = null; this.hist = null; }

  /** Rival future on the same road: arrays at t = 0, dt, ... T of track distance travelled, lateral offset and speed. */
  predict(r, T, dt, commit = true) {
    const d = this.d, ours = d.line, sh = d.shadow(r.cls) ?? ours, n = Math.round(T / dt), s = new Float64Array(n + 1), lat = new Float64Array(n + 1), v = new Float64Array(n + 1);
    const x0 = sh.stationOf(r.s), vl = sh.sample(sh.v, Math.floor(x0) % sh.N, x0 % 1, 0);
    let k = this.k.get(r.id) ?? 1; if (commit) { k += (clamp(r.v / Math.max(5, vl), 0.75, 1.2) - k) * 0.15; this.k.set(r.id, k); }
    const lat0 = sh.sample(sh.lat, Math.floor(x0) % sh.N, x0 % 1, 0), dev = r.lat - lat0;
    let x = x0, vv = r.v, trav = 0; s[0] = 0; lat[0] = r.lat; v[0] = vv;
    for (let j = 1; j <= n; j++) {
      const i = Math.floor(x) % sh.N, f = x % 1, vt = Math.min(90, k * sh.sample(sh.v, i, f, 0));
      vv += clamp(vt - vv, -16 * dt, 5 * dt); vv = Math.max(2, vv);
      const step = vv * dt; x += step / sh.ds; trav += step; s[j] = trav; v[j] = vv;
      const i2 = Math.floor(x) % sh.N; lat[j] = sh.sample(sh.lat, i2, x % 1, 0) + dev * Math.exp(-trav / 70);
    }
    return { s, lat, v };
  }

  /** The rival's lateral offset as a function of track distance: its prediction where it will be, its present offset behind it. */
  latAtFn(r, p) {
    const L = this.d.track.length, s0 = r.s;
    return (s) => {
      let x = ((s - s0) % L + L) % L; if (x > L / 2) x -= L;
      if (x <= 0) return r.lat;
      const sArr = p.s; let k = 1; while (k < sArr.length && sArr[k] < x) k++;
      if (k >= sArr.length) return p.lat[sArr.length - 1];
      const t = (x - sArr[k - 1]) / Math.max(1e-6, sArr[k] - sArr[k - 1]); return p.lat[k - 1] + (p.lat[k] - p.lat[k - 1]) * t;
    };
  }

  /**
   * The one rule for how fast we may be going behind a car: the leader's speed plus what braking at half of what the car has
   * can still take out over the gap, less a fixed distance and a reaction distance that grows with the closing speed.
   */
  capSpeed(gap, vLead, vMe) {
    const o = this.d.options, closing = Math.max(0, vMe - vLead), g = gap - (o.capGap ?? 1.0) - (o.capReact ?? 0.2) * closing;
    return vLead + Math.sqrt(2 * (o.capBrake ?? 0.5) * this.d.model.brake(vMe) * Math.max(0, g)) + (o.capSlack ?? 0.3);
  }

  /** Our rollout on a lane: position along track distance, lateral offset, speed. Rivals ahead in our band cap the speed. */
  rollout(path, i0, f0, v0, preds, rivals, T, dt) {
    const d = this.d, n = Math.round(T / dt), model = d.model;
    const s = new Float64Array(n + 1), lat = new Float64Array(n + 1), v = new Float64Array(n + 1);
    let x = i0 + f0, vv = v0, trav = 0; s[0] = 0; v[0] = v0; lat[0] = path.sample(path.lat, i0, f0, 0);
    let worst = { closing: 0, t: -1, id: -1, j: 0 }, minClear = Infinity, tCap = false, maxOver = 0;
    for (let j = 1; j <= n; j++) {
      const i = Math.floor(x) % path.N, f = x - Math.floor(x);
      let vt = path.sample(path.v, i, f, 0), wake = 0;
      // slipstream of the cars ahead (the game's own cone): more thrust on the straights, less downforce in the corners
      if (d.options.tow !== false) {
        for (let q = 0; q < rivals.length; q++) {
          const behind = (rivals[q].ds + preds[q].s[j - 1]) - trav;
          if (behind > 1.5 && behind < 110) { const cone = 2.4 + behind * 0.05, la = Math.abs(lat[j - 1] - preds[q].lat[j - 1]); if (la < cone) wake = Math.max(wake, Math.exp(-behind / 55) * (1 - (la / cone) ** 2)); }
        }
        if (wake > 0.05) { const vb = path.sample(path.vbrk, i, f, 0); if (path.vmax[i] < path.v[i] + 2) vt *= model.wakeSpeed(vv, wake); else vt = Math.max(vt, vb); }
      }
      let cap = Infinity;
      for (let q = 0; q < rivals.length; q++) {
        const r = rivals[q], p = preds[q];
        if (r.ds < -CAR_LEN && j === 1) continue;
        // gap along the road between our nose and its tail, at the previous step
        const sr = r.ds + p.s[j - 1], gap = sr - trav - CAR_LEN;
        if (!(gap > -CAR_LEN * 0.7 && sr > trav)) continue;
        // is it in our way? our lane where it is, against where it is now and over the next 0.4 and 0.8 s (a car about to move into our lane is already in the way)
        const xr = x + (sr - trav) / path.ds, mine = path.sample(path.lat, Math.floor(xr) % path.N, xr - Math.floor(xr), 0);
        const band = Math.min(Math.abs(mine - p.lat[j - 1]), Math.abs(mine - p.lat[Math.min(n, j + 3)]), Math.abs(mine - p.lat[Math.min(n, j + 7)]));
        if (band < CAR_WID + 0.55) cap = Math.min(cap, this.capSpeed(Math.max(0, gap), Math.min(p.v[j - 1], p.v[Math.min(n, j + 3)]), vv));
      }
      if (cap < Infinity) tCap = true;
      const target = Math.min(vt, cap);
      vv += clamp(target - vv, -model.brake(vv) * dt * 0.95, Math.max(0.5, model.drive(vv) + (wake > 0 ? model.towGain(vv, wake) : 0)) * dt);
      vv = Math.max(2, vv);
      const step = vv * dt; trav += step; x += step / path.ds; s[j] = trav; v[j] = vv;
      const i2 = Math.floor(x) % path.N; lat[j] = path.sample(path.lat, i2, x - Math.floor(x), 0);
      // faster than the lane can be driven even at full braking: the car runs wide there
      const over = vv - path.vbrk[i2]; if (over > maxOver) maxOver = over;
      // clearance and contact severity against every rival at this step
      for (let q = 0; q < rivals.length; q++) {
        const r = rivals[q], p = preds[q], dsl = (trav) - (r.ds + p.s[j]), dla = lat[j] - p.lat[j];
        const lonOverlap = Math.abs(dsl) < CAR_LEN + 0.2, latOverlap = Math.abs(dla) < CAR_WID + 0.1;
        const cl = Math.max(Math.abs(dsl) - CAR_LEN, Math.abs(dla) - CAR_WID);
        if (cl < minClear) minClear = cl;
        if (lonOverlap && latOverlap) {
          // contact face: whichever penetration is smaller
          const penLon = CAR_LEN - Math.abs(dsl), penLat = CAR_WID - Math.abs(dla);
          const rel = penLat < penLon ? Math.abs((lat[j] - lat[j - 1]) - (p.lat[j] - p.lat[j - 1])) / dt : Math.abs(vv - p.v[j]);
          if (rel > worst.closing) worst = { closing: rel, t: j * dt, id: r.id, j };
        }
      }
    }
    return { s, lat, v, worst, minClear, capped: tCap, over: maxOver };
  }

  /** Price of a predicted contact in metres of race distance at speed `v`. */
  contactCost(closing, v, appetite) {
    if (closing <= 0) return 0;
    const sec = 0.05 + 0.1 * closing * closing + (closing > 2.4 ? 4 : 0);
    return sec * v * appetite;
  }

  update(now, car, c, v, field, cars) {
    // c: { i, f, e } closest on the racing line; v: our speed
    const d = this.d, o = d.options, line = d.line;
    this.cap = Infinity; this.now = now; this.i0 = c.i; this.observe(now, field.me.lat); this.bookkeep(now, field, v); this.episodes(now);
    const rivals = field.list.filter((r) => !r.done && !r.ghost && r.ds > -90 && r.ds < 260 && !(r.ds < -CAR_LEN * 1.5 && r.v < v - 3));
    this.ahead = rivals.filter((r) => r.ds > 0 && r.ds < 220);
    // relevant: close ahead or closing on us, alongside, or close behind and not slower
    const rel = rivals.filter((r) => (r.ds > 0 && (r.ds < 25 + Math.max(0, v - r.v) * 4.5 || r.ds < 20)) || (r.ds <= 0 && (r.alongside || -r.ds < 25 + Math.max(0, r.v - v) * 4.5)));
    this.relList = rel;
    if (!rel.length) { this.plan = null; this.state = 'FREE'; this.focus = null; this.contact = null; this.visCands = []; return { path: line, cap: this.planCap(this.ahead, v, line) }; }
    const lead = rel.filter((r) => r.ds > 0).sort((a, b) => a.ds - b.ds)[0];
    this.state = lead && lead.ds < 80 ? 'FOLLOW' : 'FREE';
    this.focus = lead ? { id: lead.id, kind: 'follow', ds: lead.ds } : null;
    if ((o.combatMode ?? 'pass') !== 'pass') {
      // control: rear-end cap and alongside guard only
      const g = this.guard(now, car, c, v, field, rel);
      if (g) return { path: g, cap: this.planCap(this.ahead, v, g) };
      this.plan = null; this.contact = null; this.visCands = [];
      return { path: line, cap: this.planCap(this.ahead, v, line) };
    }
    return this.decide(now, car, c, v, field, rel, lead);
  }

  /** An attack episode runs while the planner holds an ATTACK lane and closes 3 s after it ends; it is a win if a pass landed inside it. */
  episodes(now) {
    const st = this.stats, atk = this.state === 'ATTACK';
    if (atk) {
      if (this.epStart == null) { this.epStart = now; this.epPasses = st.passes; st.attacks = (st.attacks ?? 0) + 1; }
      this.epLast = now;
    } else if (this.epStart != null && now - this.epLast > 3) {
      if (st.passes > this.epPasses) st.attackWins = (st.attackWins ?? 0) + 1;
      this.epStart = null;
    }
  }
  /** World points along a lane for the debugger. */
  lanePoints(lane, i0, n, step = 3) { const out = []; for (let j = 0; j <= n; j += step) { const i = lane.idx(i0 + j); out.push({ x: +lane.px[i].toFixed(2), z: +lane.pz[i].toFixed(2), v: +lane.v[i].toFixed(1), d: +(j * lane.ds).toFixed(1), l: +lane.lat[i].toFixed(2) }); } return out; }
  /**
   * Who is ahead of whom, with a hysteresis of 8 m: every change is logged with how it came about (the plan in force, our speed
   * against theirs, the lateral gap), so a pass can be told apart as a move or as plain pace.
   */
  bookkeep(now, field, v) {
    this.rank ??= new Map(); this.events ??= [];
    for (const r of field.list) {
      if (r.done || r.ghost || Math.abs(r.ds) > 120) continue;
      const was = this.rank.get(r.id), is = r.ds > 8 ? 1 : r.ds < -8 ? -1 : was ?? 0;
      if (was && is && was !== is) {
        const kind = is < 0 ? 'pass' : 'passed-by';
        if (is < 0) this.stats.passes++;
        const moved = now - (this.lastAttack ?? -99) < 4;
        if (is < 0) this.stats[moved ? 'movePasses' : 'pacePasses'] = (this.stats[moved ? 'movePasses' : 'pacePasses'] ?? 0) + 1; else this.stats.lost = (this.stats.lost ?? 0) + 1;
        this.events.push({ t: +now.toFixed(1), kind, rival: r.id, tag: this.plan?.tag ?? this.state, moved, edge: +(v - r.v).toFixed(2), gap: +Math.abs(r.dlat).toFixed(1) });
        if (this.events.length > 8) this.events.shift();
      }
      this.rank.set(r.id, is);
    }
  }

  /** Every update: the car's lateral speed over the road, filtered on the snapshot clock. */
  observe(now, lat) {
    const h = this.hist;
    if (!h || now - h.t > 0.5 || now < h.t) this.hist = { t: now, lat, vl: 0 };
    else if (now - h.t >= 0.03) { const vl = (lat - h.lat) / (now - h.t); this.hist = { t: now, lat, vl: h.vl + (vl - h.vl) * 0.4 }; }
  }
  /** Lateral slope of the car relative to the racing line (m per m of travel): its lateral speed over the road less the line's own. */
  slope(v, i0) {
    const L = this.d.line, dl = (L.sample(L.lat, L.idx(i0 + 2), 0, 0) - L.sample(L.lat, L.idx(i0 - 2), 0, 0)) / (4 * L.ds);
    return clamp((this.hist?.vl ?? 0) / Math.max(5, v) - dl, -0.25, 0.25);
  }

  /** One planning cycle, timed (wall clock, kept off `stats` so results stay comparable run to run). */
  decide(now, car, c, v, field, rel, lead) {
    if (this.plan?.lane && now < this.nextAt && this.plan.until > now) return { path: this.plan.path, cap: this.planCap(this.ahead, v, this.plan.lane) };
    const t0 = performance.now(), out = this.decideNow(now, car, c, v, field, rel, lead), ms = performance.now() - t0;
    this.cost ??= { n: 0, total: 0, max: 0 }; this.cost.n++; this.cost.total += ms; this.cost.max = Math.max(this.cost.max, ms);
    return out;
  }

  /** Candidate lanes rolled out against every relevant rival; the best outcome wins. */
  decideNow(now, car, c, v, field, rel, lead) {
    const d = this.d, o = d.options, line = d.line, me = field.me.lat ?? 0;
    const settled = d.state?.greenAt == null || now - d.state.greenAt > (o.passAfter ?? 8);     // not in the opening seconds, when the field is still sorting itself out
    const closing = lead ? v - lead.v : 0;
    // hunting: close behind and not being dropped is an attack to plan, however little we are gaining on it
    const hunt = settled && lead && lead.ds < 150 && (closing > (o.passClosing ?? 3) || (lead.ds < (o.huntRange ?? 45) && closing > -1.5));
    const near = rel.filter((r) => Math.abs(r.ds) < CAR_LEN + 2.2 && Math.abs(r.lat - me) < 3.6);
    const T = hunt ? (o.passHorizon ?? 9) : (o.safeHorizon ?? 5), dt = 0.1, preds = rel.map((r) => this.predict(r, T, dt));
    this.nextAt = now + (o.planEvery ?? 0.15); this.gen ^= 1; this.used = 0;
    const i0 = c.i, f0 = c.f, n = clamp(Math.round((T + 1.5) * v / line.ds), 60, 320);
    const d0 = me - line.sample(line.lat, i0, f0, 0);           // current offset from the racing line
    const m0 = this.slope(v, i0); this.m0 = m0; this.d0 = d0;            // how fast it is changing, per metre travelled: a new lane leaves along the same heading
    const cands = [];
    const mk = (A, tag, side, W = 0, delay = 0) => {
      const fn = typeof A === 'function', shift = new Float64Array(n + 1);
      const rin = Math.max(30, 0.85 * v, fn ? 0 : 11 * Math.abs(A - d0)) / line.ds, rout = Math.max(40, 1.0 * v) / line.ds, holdEnd = Math.max(rin + 5, n - rout);
      // a delayed lane stays on the racing line (in the slipstream) until `delay` seconds from now, then pulls out
      const j0 = delay > 0 ? Math.round(delay * v / line.ds) : 0, ramp = Math.max(30, 0.85 * v) / line.ds;
      for (let j = 0; j <= n; j++) {
        // a shadow lane tracks the rival's lateral position; a fixed lane holds its offset; both start from where the car is
        const u = j0 > 0 ? smooth((j - j0) / ramp) : 1, target = (fn ? A(j) : A) * u;
        if (j <= rin) { const u = j / rin, sm = smooth(u), base = d0 + m0 * j * line.ds * (1 - u) * (1 - u); shift[j] = sm * target + (1 - sm) * base; }
        else shift[j] = j <= holdEnd ? target : target * (1 - smooth((j - holdEnd) / (n - holdEnd)));
      }
      // keep inside the corridor
      for (let j = 0; j <= n; j++) { const ii = line.idx(i0 + j), lim = line.bound, l = line.lat[ii] + shift[j]; if (Math.abs(l) > lim) shift[j] = Math.sign(l) * lim - line.lat[ii]; }
      // the corridor edge cuts the shift station by station; smooth it so the lane has no curvature noise (a 0.2 m wobble every 3 m reads as a corner)
      for (let pass = 0; pass < 3; pass++) { let prev = shift[0]; for (let j = 1; j < n; j++) { const cur = shift[j]; shift[j] = 0.25 * prev + 0.5 * cur + 0.25 * shift[j + 1]; prev = cur; } }
      const lane = line.laneWindow(shift, i0, n, this.laneBuffer());
      lane.speedsWindow(d.model, i0, n, v, line.v[line.idx(i0 + n)], { mass: car.spec.mass + car.fuel * 0.75 });
      cands.push({ lane, A: fn ? 0 : A, tag, side, W, delay, i0, n });
    };
    mk(0, 'follow', 0);
    // holding an offset only makes sense while a car is beside us or right in front: otherwise the way back to the racing line is the plan
    if (Math.abs(d0) > 0.6 && (near.length || (lead && lead.ds < 35))) mk(d0, 'hold', Math.sign(d0));
    if (near.length) {                                           // a car beside us: the lane that holds the gap, and one that gives it room
      const nr = near.reduce((a, r) => (Math.abs(r.lat - me) < Math.abs(a.lat - me) ? r : a)), away = -(Math.sign(nr.lat - me) || 1);
      mk(d0 + away * 0.6, 'lean', away);
    }
    if (hunt) {
      const targets = rel.filter((r) => r.ds > -CAR_LEN * 2.5).sort((a, b) => Math.abs(a.ds) - Math.abs(b.ds)).slice(0, 2);
      targets.forEach((r, ti) => {
        const q = rel.indexOf(r), latAt = this.latAtFn(r, preds[q]);
        for (const W of o.passGaps ?? [2.35]) for (const sg of [-1, 1]) for (const delay of ti ? [0] : o.passDelays ?? [0, 1.5, 3, 5]) {
          const shadow = (j) => { const ii = line.idx(i0 + j), s = line.st[ii]; return latAt(s) + sg * W - line.lat[ii]; };
          mk(shadow, 'shadow', sg, W, delay);
        }
      });
    }
    // score
    const appetite = this.appetite(d.state), hold = o.planHold ?? 25;
    let best = null;
    for (const cd of cands) {
      const ro = this.rollout(cd.lane, i0, f0, v, preds, rel, T, dt);
      let P = 0;
      // outcome against the nearest rivals: how far ahead of each we end (clipped), summed over the ones we fight
      for (let q = 0; q < rel.length; q++) {
        const r = rel[q], p = preds[q], end = ro.s[ro.s.length - 1] - (r.ds + p.s[p.s.length - 1]);
        P += (Math.abs(r.ds) < 80 ? 1 : 0.4) * clamp(end, -40, 40);
      }
      const dist = ro.s[ro.s.length - 1];                                       // our own progress, metres
      // a rival that gives way (it brakes or moves over rather than hit us) makes a predicted squeeze cheaper; the prior is 0 until measured
      const yld = clamp(this.yieldOf(ro.worst.id), 0, 0.95), risk = this.contactCost(ro.worst.closing, v, appetite) * (1 - yld);
      const incumbent = this.plan && this.plan.tag === cd.tag && this.plan.side === cd.side ? hold : 0;
      cd.score = P + 0.3 * dist - risk - (o.overCost ?? 25) * Math.max(0, ro.over - 1.5) + incumbent - (ro.minClear < 0.15 && cd.tag === 'shadow' ? 6 : 0) + (cd.tag === 'shadow' && !cd.delay && lead && lead.ds < 30 ? (o.attackBias ?? 0) : 0);
      cd.ro = ro; cd.P = P; cd.risk = risk;
      if (!best || cd.score > best.score) best = cd;
    }
    this.visCands = cands.map((cd) => ({ kind: cd.tag === 'shadow' ? `${cd.delay > 0 ? 'tow→' : ''}${cd.side > 0 ? 'L' : 'R'}${cd.delay > 0 ? cd.delay.toFixed(1) + 's' : ' ' + cd.W.toFixed(1)}` : cd.tag + (cd.side ? (cd.side > 0 ? ' L' : ' R') : ''), score: cd.score, chosen: cd === best, risk: cd.risk, clear: cd.ro.minClear, points: this.lanePoints(cd.lane, i0, Math.min(cd.n, 70)) }));
    this.lastCands = cands.map((cd) => ({ tag: cd.tag, A: +cd.A.toFixed(1), score: +cd.score.toFixed(1), P: +cd.P.toFixed(1), risk: +cd.risk.toFixed(1), clear: +cd.ro.minClear.toFixed(2) }));
    this.stats.plans++;
    const chosen = best, attacking = chosen.tag === 'shadow' && !chosen.delay;
    if (attacking) this.lastAttack = now;
    this.focus = near.length && !hunt ? { id: near[0].id, kind: 'alongside', ds: near[0].ds } : lead ? { id: lead.id, kind: attacking ? 'attack' : 'follow', ds: lead.ds } : null;
    this.contact = null;
    if (chosen.ro.worst.closing > 0.3) { const jj = chosen.ro.worst.j, ii = chosen.lane.idx(i0 + Math.round(chosen.ro.s[jj] / line.ds)); this.contact = { x: +chosen.lane.px[ii].toFixed(1), z: +chosen.lane.pz[ii].toFixed(1), d: +chosen.ro.s[jj].toFixed(0), l: +chosen.lane.lat[ii].toFixed(1), closing: +chosen.ro.worst.closing.toFixed(1), t: chosen.ro.worst.t, id: chosen.ro.worst.id }; }
    if (!this.plan || this.plan.side !== chosen.side || this.plan.tag !== chosen.tag) this.stats.lanes++;
    { let mn = 0, at = 0; for (let j = 0; j <= chosen.n; j++) { const ii = line.idx(i0 + j), df = chosen.lane.v[ii] - line.v[ii]; if (df < mn) { mn = df; at = j; } } this.dbgLane = { mn: +mn.toFixed(1), at, n: chosen.n, rin: chosen.rin }; }
    const path = chosen.tag === 'follow' && Math.abs(d0) < 1.5 ? line : chosen.lane;
    this.plan = { lane: chosen.lane, path, side: chosen.side, A: chosen.A, W: chosen.W, delay: chosen.delay, until: now + 0.5, tag: chosen.tag };
    this.state = chosen.tag === 'shadow' ? (chosen.delay > 0 ? 'SETUP' : 'ATTACK') : near.length ? 'ALONGSIDE' : lead && lead.ds < 80 ? 'FOLLOW' : 'FREE';
    return { path, cap: this.planCap(this.ahead, v, chosen.lane) };
  }

  /**
   * Alongside guard (the control's only racecraft): while a car is beside us (nose to tail overlap, within a lane and a half)
   * we do not steer toward it. The lane starts from where the car is and holds that offset from the racing line, leaning away
   * only when the gap is under a body width; speed follows the lane's own profile. Returns null when nothing is alongside.
   */
  guard(now, car, c, v, field, rel) {
    const line = this.d.line, near = rel.filter((r) => Math.abs(r.ds) < CAR_LEN + 2.2 && Math.abs(r.lat - field.me.lat) < 3.6);
    if (!near.length) { this.plan = null; return null; }
    const i0 = c.i, f0 = c.f, n = clamp(Math.round(2.6 * v / line.ds), 24, 80), d0 = field.me.lat - line.sample(line.lat, i0, f0, 0);
    let side = 0, gapMin = Infinity;
    for (const r of near) { const g = Math.abs(r.lat - field.me.lat) - CAR_WID; if (g < gapMin) { gapMin = g; side = Math.sign(r.lat - field.me.lat); } }
    // lean away from the nearest car a little when it is closer than 0.35 m, never toward it
    const lean = gapMin < 0.35 ? -side * Math.min(0.5, 0.35 - gapMin + 0.1) : 0;
    const shift = new Float64Array(n + 1);
    for (let j = 0; j <= n; j++) { const ii = line.idx(i0 + j), tgt = d0 + lean * smooth(j / 12), l = line.lat[ii] + tgt; shift[j] = Math.abs(l) > line.bound ? Math.sign(l) * line.bound - line.lat[ii] : tgt; }
    this.gen ^= 1; this.used = 0;
    const lane = line.laneWindow(shift, i0, n, this.laneBuffer());
    lane.speedsWindow(this.d.model, i0, n, v, line.v[line.idx(i0 + n)], { mass: car.spec.mass + car.fuel * 0.75 });
    this.plan = { lane, path: lane, side, A: d0, tag: 'guard', until: now + 0.2 }; this.state = 'ALONGSIDE'; this.stats.guards = (this.stats.guards ?? 0) + 1;
    const nr = near.reduce((a, r) => (Math.abs(r.lat - field.me.lat) < Math.abs(a.lat - field.me.lat) ? r : a)); this.focus = { id: nr.id, kind: 'alongside', ds: nr.ds }; this.contact = null;
    this.visCands = [{ kind: 'guard hold', score: 0, chosen: true, points: this.lanePoints(lane, i0, n) }];
    return lane;
  }

  /**
   * Lateral discipline. The fastest we may drift toward a car that is, or within a second will be, alongside: the clear gap
   * (less a margin) spread over a reaction time, plus whatever the other car drifts away. Returns the most binding car as
   * { dir: side it is on (+1 = left), rate: allowed drift toward it in m/s (negative: must move away) } or null.
   */
  neighbor(v) {
    const f = this.d.field, me = f.me, o = this.d.options, margin = o.latMargin ?? 0.35, T = o.latTime ?? 0.8;
    let best = null;
    for (const r of f.list) {
      if (r.done || r.ghost) continue;
      const lon = Math.abs(r.ds) - CAR_LEN, rel = r.ds > 0 ? v - r.v : r.v - v;          // clear distance along the road, closing speed along it
      if (!(lon <= 0.3 || (rel > 0.5 && lon / rel < 1.0))) continue;
      const dlat = r.lat - me.lat, dir = Math.sign(dlat) || 1, gap = Math.abs(dlat) - CAR_WID;
      if (gap > 4) continue;
      const allow = (gap - margin) / T + dir * r.vl;
      if (!best || allow < best.rate) best = { dir, rate: allow, id: r.id, gap };
    }
    return best;
  }

  /**
   * Speed cap that keeps the nose off a car ahead in our lane. It is the highest speed from which braking at half of what the
   * car has still keeps the gap open while that car does what it is predicted to do (including the braking zone it is about
   * to enter), recomputed every frame. At a constant leader speed it reduces to `capSpeed`. A car that is already beside us
   * (its tail not ahead of our nose) is the lateral logic's business, not the brakes'. `lane` is the path we are on, so a
   * car we are about to pull out from behind does not hold us up.
   */
  planCap(ahead, v, lane) {
    let cap = Infinity;
    const my = this.d.field.me.lat, model = this.d.model, o = this.d.options, a = (o.capBrake ?? 0.5) * model.brake(v), dt = 0.2, ds = this.d.line.ds;
    for (const r of ahead) {
      if (r.ds <= CAR_LEN - 0.3) continue;
      const gap = r.ds - CAR_LEN - (o.capGap ?? 1.0) - (o.capReact ?? 0.2) * Math.max(0, v - r.v);
      // is it in our way over the next second? its lateral offset a moment from now against where our lane will be there
      const mine = lane ? lane.lat[lane.idx(this.i0 + Math.round(r.ds / ds))] : my, lateral = Math.min(Math.abs(r.lat - mine), Math.abs(r.lat + r.vl * 0.8 - mine));
      if (lateral >= CAR_WID + 0.5) continue;
      let c = Infinity;
      if (o.capForecast === false) c = r.v + Math.sqrt(2 * a * Math.max(0, gap));
      else {
        const p = this.predict(r, 3, dt, false), dec = Math.min(0, r.a ?? 0);
        for (let j = 1; j < p.s.length; j++) {
          const tau = j * dt, sr = dec < -3 ? Math.min(p.s[j], Math.max(0, r.v * tau + 0.5 * dec * tau * tau)) : p.s[j];   // a leader already braking hard may do so beyond the forecast
          c = Math.min(c, (gap + sr + 0.5 * a * tau * tau) / tau);
        }
      }
      cap = Math.min(cap, c + (o.capSlack ?? 0.3));
    }
    this.cap = cap; return cap;
  }

  /**
   * What the debugger draws: the rivals the planner is working with and where it expects them, the lanes it weighed, the
   * contact it expects on the chosen one, and the recent pass log. Read-only; the planner never calls it.
   */
  vis() {
    const d = this.d, track = d.track, rel = (this.relList ?? []).slice().sort((a, b) => Math.abs(a.ds) - Math.abs(b.ds)).slice(0, 5);
    const rivals = rel.map((r) => {
      const p = this.predict(r, 3, 0.5, false), pts = [], rp = [];
      for (let j = 0; j < p.s.length; j++) { const q = track.at(r.s + p.s[j], p.lat[j]); pts.push({ x: +q.x.toFixed(1), z: +q.z.toFixed(1) }); rp.push([+(r.ds + p.s[j]).toFixed(1), +p.lat[j].toFixed(2)]); }
      return { id: r.id, kind: r.alongside ? 'alongside' : r.ds > 0 ? 'ahead' : 'behind', d: +r.ds.toFixed(1), l: +r.lat.toFixed(2), v: +r.v.toFixed(1), vl: +r.vl.toFixed(1), pts, rp, focus: this.focus?.id === r.id };
    });
    const lanes = (this.visCands ?? []).map((c) => ({ kind: c.kind, chosen: c.chosen, score: +c.score.toFixed(1), rp: c.points.map((q) => [q.d, q.l]) }));
    return { rivals, lanes, contact: this.contact ?? null, cap: Number.isFinite(this.cap) ? +this.cap.toFixed(1) : null, events: (this.events ?? []).slice(-5) };
  }
  /** How readily this rival gives way (0 = never, 1 = always). */
  yieldOf(id) { return this.d.options.yieldPrior ?? 0; }
  appetite(state) {
    const inc = state?.incidents ?? 0, lim = state?.incidentLimits?.penalty ?? 17;
    return 1 + 3 * clamp(inc / lim, 0, 1) ** 2;
  }
}
