import { clamp } from './math.js';
import { CAR_LEN, CAR_WID } from './field.js';

const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

/**
 * Racecraft planner. Every cycle it builds a handful of lanes (windowed copies of the racing line shifted sideways, each
 * with its own speed profile), rolls each one forward against predicted rivals on the same clock, and picks the lane
 * with the best outcome: position gained at the horizon minus the price of any contact it risks. The price of contact
 * rises with closing speed (damage, tyre loss and, above the steward threshold, incident points on both cars), so a
 * nudge at nearly zero closing speed is nearly free and a hit is never worth it. The chosen lane is followed by the
 * normal tracker; a cap on speed keeps the nose off whatever is ahead in the lane.
 */
export class Combat {
  constructor(driver) {
    this.d = driver; this.plan = null; this.nextAt = -1; this.k = new Map(); this.state = 'FREE'; this.stats = { plans: 0, passes: 0, aborts: 0, lanes: 0 };
    this.cap = Infinity; this.lastCands = []; this.side = 0;
  }
  reset() { this.plan = null; this.nextAt = -1; this.k.clear(); this.state = 'FREE'; this.cap = Infinity; this.side = 0; }

  /** Rival future on the same road: arrays at t = 0, dt, ... T of track distance travelled, lateral offset and speed. */
  predict(r, T, dt) {
    const d = this.d, ours = d.line, sh = d.shadow(r.cls) ?? ours, n = Math.round(T / dt), s = new Float64Array(n + 1), lat = new Float64Array(n + 1), v = new Float64Array(n + 1);
    const x0 = sh.stationOf(r.s), vl = sh.sample(sh.v, Math.floor(x0) % sh.N, x0 % 1, 0);
    let k = this.k.get(r.id) ?? 1; k += (clamp(r.v / Math.max(5, vl), 0.75, 1.2) - k) * 0.15; this.k.set(r.id, k);
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

  /** Our rollout on a lane: position along track distance, lateral offset, speed. Rivals ahead in our band cap the speed. */
  rollout(path, i0, f0, v0, preds, rivals, T, dt, startDs = 0) {
    const d = this.d, n = Math.round(T / dt), model = d.model;
    const s = new Float64Array(n + 1), lat = new Float64Array(n + 1), v = new Float64Array(n + 1);
    let x = i0 + f0, vv = v0, trav = 0; s[0] = 0; v[0] = v0; lat[0] = path.sample(path.lat, i0, f0, 0);
    let worst = { closing: 0, t: -1, id: -1 }, minClear = Infinity, tCap = false;
    for (let j = 1; j <= n; j++) {
      const i = Math.floor(x) % path.N, f = x - Math.floor(x), vt = path.sample(path.v, i, f, 0);
      let cap = Infinity;
      for (let q = 0; q < rivals.length; q++) {
        const r = rivals[q], p = preds[q];
        if (r.ds < -CAR_LEN && j === 1) continue;
        // gap along the road between our nose and its tail, at the previous step
        const gap = (r.ds + p.s[j - 1]) - trav - CAR_LEN, band = Math.abs(lat[j - 1] - p.lat[j - 1]);
        if (gap > -CAR_LEN * 0.7 && band < CAR_WID + 0.55 && r.ds + p.s[j - 1] > trav) cap = Math.min(cap, p.v[j - 1] + 1.0 + Math.sqrt(2 * 0.75 * model.brake(vv) * Math.max(0, gap - 0.4)));
      }
      if (cap < Infinity) tCap = true;
      const target = Math.min(vt, cap);
      vv += clamp(target - vv, -model.brake(vv) * dt * 0.95, Math.max(0.5, model.drive(vv)) * dt);
      vv = Math.max(2, vv);
      const step = vv * dt; trav += step; x += step / path.ds; s[j] = trav; v[j] = vv;
      const i2 = Math.floor(x) % path.N; lat[j] = path.sample(path.lat, i2, x - Math.floor(x), 0);
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
          if (rel > worst.closing) worst = { closing: rel, t: j * dt, id: r.id };
        }
      }
    }
    return { s, lat, v, worst, minClear, capped: tCap };
  }

  /** Price of a predicted contact in metres of race distance at speed `v`. */
  contactCost(closing, v, appetite) {
    if (closing <= 0) return 0;
    const sec = 0.05 + 0.1 * closing * closing + (closing > 2.4 ? 4 : 0);
    return sec * v * appetite;
  }

  update(now, car, c, v, field, cars) {
    // c: { i, f, e } closest on the racing line; v: our speed
    const d = this.d, line = d.line;
    this.cap = Infinity;
    const rivals = field.list.filter((r) => !r.done && !r.ghost && r.ds > -90 && r.ds < 260 && !(r.ds < -CAR_LEN * 1.5 && r.v < v - 3));
    // relevant: close ahead or closing on us, alongside, or close behind and not slower
    const rel = rivals.filter((r) => (r.ds > 0 && (r.ds < 25 + Math.max(0, v - r.v) * 4.5 || r.ds < 20)) || (r.ds <= 0 && (r.alongside || -r.ds < 25 + Math.max(0, r.v - v) * 4.5)));
    if (!rel.length) { this.plan = null; this.state = 'FREE'; return { path: line, cap: Infinity }; }
    const lead = rel.filter((r) => r.ds > 0).sort((a, b) => a.ds - b.ds)[0];
    this.state = lead && lead.ds < 80 ? 'FOLLOW' : 'FREE';
    // 1. a car beside us: do not steer into it
    const g = this.guard(now, car, c, v, field, rel);
    if (g) return { path: g, cap: this.planCap(rel, v) };
    // 2. a car we are catching that we cannot simply follow past: plan the pass (never in the opening seconds, when the field is still sorting itself out)
    const settled = d.state?.greenAt == null || now - d.state.greenAt > (d.options.passAfter ?? 8);
    const closing = lead ? v - lead.v : 0;
    if ((d.options.combatMode ?? 'pass') === 'pass' && settled && lead && closing > (d.options.passClosing ?? 3) && lead.ds < 150) return this.planPass(now, car, c, v, field, rel, lead);
    this.plan = null;
    return { path: line, cap: this.planCap(rel, v) };
  }

  /** Plan a pass of `lead`: candidate lanes rolled out against every relevant rival, best outcome wins. */
  planPass(now, car, c, v, field, rel, lead) {
    const d = this.d, line = d.line;
    // hold the previous plan between cycles; replan on the clock
    if (this.plan && now < this.nextAt && this.plan.until > now) return { path: this.plan.lane, cap: this.planCap(rel, v) };
    this.nextAt = now + 0.12;
    const T = 5, dt = 0.1, preds = rel.map((r) => this.predict(r, T, dt));
    const i0 = c.i, f0 = c.f, n = clamp(Math.round(6.5 * v / line.ds), 50, 170);
    const d0 = (field.me.lat ?? 0) - line.sample(line.lat, i0, f0, 0);          // current offset from the racing line
    const cands = [];
    const mk = (A, hold, tag, side, W = 0) => {
      const fn = typeof A === 'function', shift = new Float64Array(n + 1);
      const rin = Math.max(30, 0.85 * v, fn ? 0 : 11 * Math.abs(A - d0)) / line.ds, rout = Math.max(40, 1.0 * v) / line.ds, holdEnd = Math.max(rin + 5, Math.min(n - rout, hold / line.ds));
      for (let j = 0; j <= n; j++) {
        // a shadow lane tracks the rival's lateral position; a fixed lane holds its offset; both start from where the car is
        const target = fn ? A(j) : A, a = j <= rin ? d0 + (target - d0) * smooth(j / rin) : j <= holdEnd ? target : target * (1 - smooth((j - holdEnd) / (n - holdEnd)));
        shift[j] = a;
      }
      // keep inside the corridor
      for (let j = 0; j <= n; j++) { const ii = line.idx(i0 + j), lim = line.bound; const l = line.lat[ii] + shift[j]; if (Math.abs(l) > lim) shift[j] = Math.sign(l) * lim - line.lat[ii]; }
      const lane = line.laneWindow(shift, i0, n);
      lane.speedsWindow(d.model, i0, n, v, line.v[line.idx(i0 + n)], { mass: car.spec.mass + car.fuel * 0.75 });
      cands.push({ lane, A: fn ? 0 : A, tag, side, W, i0, n });
    };
    // follow the racing line; hold the present lateral offset; and shadow lanes that run beside each nearby rival
    mk(0, 1e9, 'follow', 0);
    if (Math.abs(d0) > 0.6) mk(d0, 1e9, 'hold', Math.sign(d0));
    const targets = rel.filter((r) => r.ds > -CAR_LEN * 2.5).sort((a, b) => Math.abs(a.ds) - Math.abs(b.ds)).slice(0, 2);
    for (const r of targets) {
      const q = rel.indexOf(r), latAt = this.latAtFn(r, preds[q]);
      for (const W of [2.06, 2.5]) for (const sg of [-1, 1]) {
        const shadow = (j) => { const ii = line.idx(i0 + j), s = line.st[ii]; return latAt(s) + sg * W - line.lat[ii]; };
        mk(shadow, 1e9, 'shadow', sg, W);
      }
    }
    // score
    const appetite = this.appetite(d.state);
    let best = null;
    for (const cd of cands) {
      const ro = this.rollout(cd.lane, i0, f0, v, preds, rel, T, dt);
      let P = 0;
      // outcome against the nearest rivals: how far ahead of each we end (clipped), summed over the ones we fight
      for (let q = 0; q < rel.length; q++) {
        const r = rel[q], p = preds[q], end = ro.s[ro.s.length - 1] - (r.ds + p.s[p.s.length - 1]);
        const w = Math.abs(r.ds) < 80 ? 1 : 0.4;
        P += w * clamp(end, -40, 40);
      }
      const dist = ro.s[ro.s.length - 1];                                       // our own progress, metres
      const risk = this.contactCost(ro.worst.closing, v, appetite);
      const continuity = this.plan && this.plan.side === cd.side && this.plan.tag === cd.tag && this.plan.W === cd.W ? 5 : 0;
      cd.score = P + 0.3 * dist - risk + continuity - (ro.minClear < 0.15 && cd.tag === 'shadow' ? 6 : 0);
      cd.ro = ro; cd.P = P; cd.risk = risk;
      if (!best || cd.score > best.score) best = cd;
    }
    this.lastCands = cands.map((cd) => ({ tag: cd.tag, A: +cd.A.toFixed(1), score: +cd.score.toFixed(1), P: +cd.P.toFixed(1), risk: +cd.risk.toFixed(1), clear: +cd.ro.minClear.toFixed(2) }));
    this.stats.plans++;
    const chosen = best;
    if (!this.plan || this.plan.side !== chosen.side) this.stats.lanes++;
    this.plan = { lane: chosen.lane, side: chosen.side, A: chosen.A, W: chosen.W, until: now + 0.5, tag: chosen.tag };
    this.state = chosen.tag === 'shadow' ? 'ATTACK' : (lead && lead.ds < 80 ? 'FOLLOW' : 'FREE');
    return { path: chosen.tag === 'follow' && Math.abs(d0) < 1.5 ? line : chosen.lane, cap: this.planCap(rel, v) };
  }

  /**
   * Alongside guard: while a car is beside us (nose to tail overlap, within a lane and a half) we do not steer toward it.
   * The lane starts from where the car is and holds that offset from the racing line, leaning away only when the gap is
   * under a body width; speed follows the lane's own profile. Returns null when nothing is alongside.
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
    const lane = line.laneWindow(shift, i0, n);
    lane.speedsWindow(this.d.model, i0, n, v, line.v[line.idx(i0 + n)], { mass: car.spec.mass + car.fuel * 0.75 });
    this.plan = { lane, side, A: d0, tag: 'guard', until: now + 0.2 }; this.state = 'ALONGSIDE';
    return lane;
  }

  /** Speed cap that keeps the nose off a car ahead in our band (comfortable braking), recomputed every frame. */
  planCap(rel, v) {
    let cap = Infinity;
    const my = this.d.field.me.lat, model = this.d.model;
    for (const r of rel) {
      if (r.ds <= 0) continue;
      const gap = r.ds - CAR_LEN;
      // is it in our way over the next second? its lateral offset a moment from now against ours
      const lateral = Math.min(Math.abs(r.lat - my), Math.abs(r.lat + r.vl * 0.8 - my));
      if (lateral < CAR_WID + 0.35) cap = Math.min(cap, r.v + 1.0 + Math.sqrt(2 * 0.75 * model.brake(v) * Math.max(0, gap - 0.4)));
    }
    this.cap = cap; return cap;
  }
  appetite(state) {
    const inc = state?.incidents ?? 0, lim = state?.incidentLimits?.penalty ?? 17;
    return 1 + 3 * clamp(inc / lim, 0, 1) ** 2;
  }
}
