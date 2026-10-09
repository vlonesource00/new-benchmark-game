import { clamp } from '../../apex/src/math.js';
import { at, atDs, validAt } from './forecast.js';
import { HALF_LEN } from './perception.js';
import { OFFSETS } from './atlas.js';
import { blend, changeLength, join } from './lattice.js';

const ON_LINE = { d0: 0, p0: 0, c0: 0 };

const wrap = (x, L) => ((x + L * 1.5) % L) - L / 2;

/**
 * The executor's view of a proposal. A proposal (segments of library lanes) is turned into the exact lane the
 * controller would follow — the same shift, the same window geometry, the same quasi-steady solver — and driven
 * forward in time against the rival forecasts: speed is the lane profile from the car's present speed, capped by
 * braking room behind cars in the band, limited by what the drive adds back. Contact risk and the outcome at the
 * horizon are priced as in the lattice. Every candidate ends back on the racing line at the same distance, so
 * their times are comparable, and the rejoin is part of the price.
 */
export class Rollout {
  constructor(driver, pool = 9) {
    this.driver = driver; this.pool = Array.from({ length: pool }, () => driver.line.blankLane()); this.busy = new Set();
    this.shift = new Float64Array(4096); this.cap = new Float64Array(4096); this.tAt = new Float64Array(4096); this.lat = new Float64Array(4096);
  }
  reset() { for (const l of this.pool) this.restore(l); this.busy.clear(); }
  /** Put a pooled lane's previous window back onto the racing line before it is reused. */
  restore(lane) {
    const w = lane.window, line = this.driver.line; if (!w) return;
    const keys = ['px', 'pz', 'len', 'h', 'k', 'ks', 'dk', 'lat', 'vmax', 'v', 'vbrk'];
    for (const key of keys) { const src = line[key], dst = lane[key]; for (let c = -16; c <= w.n + 18; c++) { const i = line.idx(w.i0 + c); dst[i] = src[i]; } }
    lane.window = null;
  }
  /**
   * A window lane with the same curvature treatment a full lane gets: the shift's added curvature is low-passed
   * (the three-point stencil reads it with station-scale noise), then the smoothed curvature and its rate are
   * rebuilt. Without it the window reads ~9 % slower than the identical lane built whole (jerk limits on noise).
   */
  window(shift, i0, n, lane) {
    const line = this.driver.line, a = -8, b = n + 10, m = b - a + 1;
    line.laneWindow(shift, i0, n, lane);
    const dk = this.dk ??= new Float64Array(4200), tmp = this.dkT ??= new Float64Array(4200);
    for (let c = 0; c < m; c++) { const i = line.idx(i0 + a + c); dk[c] = lane.k[i] - line.k[i]; }
    for (let pass = 0; pass < 2; pass++) {
      tmp.set(dk.subarray(0, m));
      for (let c = 0; c < m; c++) { let t = 0; for (let q = -2; q <= 2; q++) t += (3 - Math.abs(q)) * tmp[clamp(c + q, 0, m - 1)]; dk[c] = t / 9; }
    }
    for (let c = 0; c < m; c++) { const i = line.idx(i0 + a + c); lane.k[i] = line.k[i] + dk[c]; }
    for (let c = 1; c < m - 1; c++) { const i = line.idx(i0 + a + c); lane.ks[i] = 0.25 * lane.k[line.idx(i - 1)] + 0.5 * lane.k[i] + 0.25 * lane.k[line.idx(i + 1)]; }
    for (let c = 4; c < m - 4; c++) { const i = line.idx(i0 + a + c); lane.dk[i] = Math.abs(lane.ks[line.idx(i + 3)] - lane.ks[line.idx(i - 3)]) / Math.max(1e-6, 6 * lane.len[i]); }
    return lane;
  }
  take(keep) {
    const lane = this.pool.find((l) => l !== keep && !this.busy.has(l)) ?? this.pool.find((l) => l !== keep);
    this.busy.add(lane); this.restore(lane); return lane;
  }
  /** Shift (from the racing line) of proposal `p` at distance x ahead of the car. */
  shiftAt(p, x, i, start) {
    const lanes = this.driver.atlas.lanes, segs = p.segs, dS = p.dS, k = x / dS;
    let cur = segs[0].lane, s = lanes[cur].shift[i];
    for (let q = 0; q < segs.length; q++) {
      const g = segs[q];
      if (k < g.k0) break;
      const sb = lanes[g.lane].shift[i];
      if (k >= g.k1) { cur = g.lane; s = sb; continue; }
      const L = (g.k1 - g.k0) * dS, u = (x - g.k0 * dS) / L;
      if (q === 0) s = join(start, sb, L, u);
      else { const w = blend(u); s = lanes[cur].shift[i] * (1 - w) + sb * w; }
      return s;
    }
    return s;
  }
  /**
   * A rival-relative lane: join from the car to a station beside the rival's forecast track (its side, its width plus
   * a small clearance), ride there while the pass plays out, then blend back to the line. The library lanes are fixed
   * offsets from the line; a rival off the line has no library lane beside it.
   */
  besideAt(p, x, i, start, tOf) {
    const b = p.beside, line = this.driver.line, f = b.f;
    const want = (xx) => at(f.lat, tOf(xx)) + b.side * b.gap - line.lat[i];
    // a delayed move rides the line first and leaves it at b.delay: the same pass, later off the fast line
    const dl = b.delay ?? 0;
    if (dl > 0 && x <= dl) return join(start, 0, dl, clamp(x / dl, 0, 1));
    if (x <= dl + b.entry) return join(dl > 0 ? ON_LINE : start, want(x), b.entry, clamp((x - dl) / b.entry, 0, 1));
    if (x <= dl + b.entry + b.hold) return want(x);
    const xe = dl + b.entry + b.hold, se = at(f.lat, tOf(xe)) + b.side * b.gap - line.lat[i];
    return se * (1 - blend(clamp((x - xe) / b.rejoin, 0, 1)));
  }
  /**
   * Builds the lane for proposal p into a pooled Line and scores it. Returns { lane, score, tH, passes, contact,
   * caps per layer, lat per layer, t per layer } — the controller's own path, ready to drive.
   */
  evaluate(p, plan, me, car, keep, tFix = null) {
    const d = this.driver, line = d.line, model = d.model, o = d.options, ds = line.ds, L = d.track.length;
    const st0 = line.stationOf(me.s), i0 = Math.floor(st0) - 1;
    const H = p.K * p.dS, v0 = Math.max(8, me.v);
    // every candidate rejoins the line inside the same window: the longest rejoin any lane could need at this speed
    const rejoinMax = changeLength(Math.max(...OFFSETS.map(Math.abs)), v0, o.rejoinA ?? 4);
    const lastOff = this.driver.atlas.lanes[p.last].shift;
    const n = Math.min(this.shift.length - 1, Math.ceil((H + rejoinMax) / ds) + 2);
    const iH = line.idx(i0 + Math.ceil((H + wrap(i0 * ds - me.s, L)) / ds));
    const rejoin = changeLength(Math.abs(lastOff[iH]), Math.max(8, line.v[iH]), o.rejoinA ?? 4);
    const hw = p.hold?.window, N = line.N;
    // when the car reaches a distance ahead, for placing it beside the rival's forecast. besideTime: the line's profile
    // limited by what the drive adds from the present speed (the drive below uses the same model). Otherwise the
    // present speed held, cut at 4.4 s: it reads the rival's lateral too early wherever the car brakes
    let tOf = (xx) => clamp(xx / v0, 0, 4.4);
    const xs = (this.xs ??= new Float64Array(4096)), ts = (this.ts ??= new Float64Array(4096));
    if (p.beside) {
      let v = Math.max(1, car.speed), t = 0, xp = wrap(line.idx(i0) * ds - me.s, L); xs[0] = xp; ts[0] = 0;
      const mass = car.spec.mass + car.fuel * 0.75;
      for (let j = 1; j <= n; j++) {
        const i = line.idx(i0 + j), x = wrap(i * ds - me.s, L), seg = line.len[line.idx(i - 1)] * clamp((x - Math.max(0, xp)) / ds, 0, 1);
        const vn = Math.max(1, Math.min(line.v[i], Math.sqrt(v * v + 2 * seg * Math.max(0.5, model.drive(v, mass)))));
        if (x > 0) { t += seg / Math.max(1, 0.5 * (v + vn)); v = vn; }
        xs[j] = x; ts[j] = t; xp = x;
      }
      const lookup = (arr) => (xx) => { let lo = 0, hi = n; if (xx <= xs[0]) return arr[0]; if (xx >= xs[n]) return arr[n]; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= xx) lo = m; else hi = m; } return arr[lo] + (arr[hi] - arr[lo]) * (xx - xs[lo]) / Math.max(1e-9, xs[hi] - xs[lo]); };
      if (tFix) tOf = lookup(tFix);
      else if (o.besideTime === true || o.besideTime === 'drive') tOf = lookup(ts);
      this.tLookup = lookup;
    }
    for (let j = 0; j <= n; j++) {
      const i = line.idx(i0 + j), x = wrap(i * ds - me.s, L);
      let s;
      // the committed path, as it stands: its own shift where its window reaches, the line beyond (it already rejoined)
      if (p.beside) s = this.besideAt(p, x, i, plan.start, tOf);
      else if (hw) { const c = (i - hw.i0 + 2 * N) % N; s = c <= hw.n ? p.hold.lat[i] - line.lat[i] : 0; }
      else if (x <= 0) s = plan.start.d0;
      else if (x <= H) s = this.shiftAt(p, x, i, plan.start);
      else s = lastOff[i] * (1 - blend((x - H) / rejoin));
      this.shift[j] = clamp(line.lat[i] + s, -line.bound, line.bound) - line.lat[i];
    }
    const lane = this.take(keep);
    this.window(this.shift.subarray(0, n + 1), i0, n, lane);
    const iE = line.idx(i0 + n), mass = car.spec.mass + car.fuel * 0.75;
    // unifiedLane: the lane is built once, as the controller will drive it (its margin, its demand from the line's speed
    // or faster); the drive below still starts from the car's own speed and adds only what the engine can
    const unified = o.unifiedLane === true, m0 = model.margin;
    if (unified) model.margin = d.laneMargin ?? m0;
    lane.speedsWindow(model, i0, n, unified ? Math.max(car.speed, line.v[line.idx(i0)]) : car.speed, line.v[iE], { ...d.sopt, mass, vbrkEnd: line.vbrk[iE], jerk: o.laneJerk ?? model.jerk });
    model.margin = m0;
    // drive it: time and speed station by station, against the forecasts. With freeThrust the controller drives the
    // braking envelope (full throttle until it must brake), so that is the demand scored
    const prof = o.freeThrust === true ? lane.vbrk : lane.v;
    const wE = me.halfWidth ?? 0.98, colC = o.contactCost ?? 3, B = o.passValue ?? 0.45;
    const caps = this.cap, tAt = this.tAt, latA = this.lat, peak = (this.peak ??= new Float64Array(64));
    const env = (this.env ??= new Float64Array(4096)), segA = (this.segA ??= new Float64Array(4096));
    const event = (o.contactMode ?? 'event') === 'event', behind = o.behindShare ?? 0.4, useWake = o.rolloutWake !== false, capB = o.capBrake ?? 0.55;
    // capEnvelope: a following cap is a speed at a place, and the controller brakes to it beforehand (the committed
    // plan's cap envelope). A first pass finds the caps; the second drives against their braking envelope instead of
    // slowing at the cap itself
    const nPass = o.capEnvelope === true ? 2 : 1, bEnv = (o.envBrake ?? 0.6) * model.brake(30);
    let t, v, cost, contact, tH, maxDev, out, xPrev;
    for (let pass = 0; pass < nPass; pass++) {
    if (pass) { env[n] = caps[n]; for (let j = n - 1; j >= 1; j--) env[j] = Math.min(caps[j], Math.sqrt(env[j + 1] * env[j + 1] + 2 * bEnv * segA[j + 1])); }
    t = 0; tAt[0] = 0; v = Math.max(1, car.speed); cost = 0; contact = 0; tH = NaN; maxDev = 0; out = -1; xPrev = wrap(line.idx(i0) * ds - me.s, L); peak.fill(0, 0, plan.fs.length);
    for (let j = 1; j <= n; j++) {
      const i = line.idx(i0 + j), x = wrap(i * ds - me.s, L), seg = lane.len[line.idx(i - 1)] * clamp((x - xPrev) / ds, 0, 1);
      const dB = lane.lat[i];
      let vp = prof[i], cap = Infinity, wake = 0;
      if (x > 0) for (let q = 0; q < plan.fs.length; q++) {
        const f = plan.fs[q], r = f.r, g = atDs(f, t) - x, rd = at(f.lat, t), sg = at(f.sig, t), sgs = at(f.sigS, t), rv = at(f.v, t);
        const Ls = HALF_LEN + r.halfLength, c = Math.abs(dB - rd) - (wE + r.across);
        // the game's wake cone behind every car: less downforce in the corners, less drag on the straights
        if (useWake && g > 1.5 && g < 110 && !r.hazard) { const cw = 2.4 + 0.05 * g, la = Math.abs(dB - rd); if (la < cw) wake = Math.max(wake, Math.exp(-g / 55) * (1 - (la / cw) ** 2)); }
        if (Math.abs(g) < Ls + 0.5 * sgs) {
          const need = (o.clearBase ?? 0.2) + (o.clearSig ?? 0.5) * sg;
          if (c < need) {
            const risk = clamp((need - c) / (sg + 0.3), 0, 1), conf = Math.exp(-Math.max(0, t - 0.6) / 1.5);
            const sev = risk * conf * (r.hazard ? 2 : 1) * (1 + Math.abs(vp - rv) / 6);
            if (event) peak[q] = Math.max(peak[q], sev);
            else { const pc = colC * sev * (seg / p.dS); cost += pc; contact += pc; }
          }
        } else if (g > 0 && g < 90 && c < 0.35 + 0.4 * sg) {
          const room = g - Ls - 0.8 - 0.25 * sgs - 0.15 * Math.max(0, vp - rv);
          cap = Math.min(cap, rv + Math.sqrt(2 * capB * model.brake(Math.max(8, rv)) * Math.max(0, room)));
        }
      }
      if (wake > 0.02) vp = Math.min(vp, lane.vmax[i] * model.wakeSpeed(lane.vmax[i], wake));
      const vAcc = Math.sqrt(v * v + 2 * seg * Math.max(0.5, model.drive(v, mass) + (wake > 0 ? model.towGain(v, wake) : 0)));
      const vn = Math.max(1, Math.min(vp, cap, pass ? env[j] : Infinity, vAcc));
      segA[j] = seg;
      const dtS = seg / Math.max(1, 0.5 * (v + vn));
      t += dtS; v = vn; xPrev = x;
      if (x > 0) cost += (o.offline ?? 0.004) * Math.abs(this.shift[j]) * dtS;
      const dz = plan.defendZone;
      if (dz && x > dz.from && x < dz.to) cost += (o.defendCost ?? 0.03) * clamp((d.atlas.bound - dB * dz.inside - 2.4) / 2.5, 0, 1) * seg / p.dS;
      caps[j] = cap; tAt[j] = t; latA[j] = dB;
      if (x <= H) maxDev = Math.max(maxDev, Math.abs(this.shift[j]));
      if (out < 0 && x > 0 && Math.abs(this.shift[j]) > 0.5) out = x;
      if (Number.isNaN(tH) && x >= H) tH = t;
    }
    }
    // contact is an event, not a distance: the worst moment against each car, shared with a car that is behind
    if (event) for (let q = 0; q < plan.fs.length; q++) {
      const r = plan.fs[q].r, pc = colC * peak[q] * (!r.hazard && r.ds < 0 ? behind : 1);
      cost += pc; contact += pc;
    }
    // outcome at the horizon, as in the lattice
    let passes = 0, lost = 0, who = null;
    if (validAt(tH)) for (const f of plan.fs) {
      const r = f.r; if (!r.target || r.mate) continue;
      const g0 = r.ds, gE = atDs(f, tH) - H, Ls = HALF_LEN + r.halfLength;
      if (g0 > -Ls && gE < -0.6 * Ls) { passes++; if (who == null || g0 < who.g) who = { id: r.id, g: g0 }; }
      else if (g0 < 0 && gE > -0.3 * Ls) lost++;
    }
    const score = t + cost - B * (passes - lost);
    const ev = { lane, i0, n, score, t, tH, passes, lost, contact, maxDev, p, who: who?.id ?? null, out, unified, prof: prof === lane.vbrk ? 'vbrk' : 'v' };
    // the time used to place the end of the beside hold, against the time this drive reaches it (diagnostic)
    if (p.beside) { const b = p.beside, xe = (b.delay ?? 0) + b.entry + b.hold; ev.bt = { used: tOf(xe), held: clamp(xe / v0, 0, 4.4), drive: this.tLookup(tAt)(xe) }; }
    // besideTime 'drive': place the lane again on the times this drive took (one fixed-point step)
    if (p.beside && o.besideTime === 'drive' && !tFix) { this.busy.delete(lane); return this.evaluate(p, plan, me, car, keep, Float64Array.from(tAt.subarray(0, n + 1))); }
    ev.lay = this.layers(ev, me);
    return ev;
  }
  /** Layer view of an evaluated candidate for the committed plan (lateral, time and cap at each lattice layer). */
  layers(ev, me) {
    const p = ev.p, line = this.driver.line, ds = line.ds, L = this.driver.track.length, K = p.K;
    const d = new Float64Array(K + 1), t = new Float64Array(K + 1), cap = new Float64Array(K + 1).fill(Infinity);
    d[0] = me.d;
    let xp = wrap(line.idx(ev.i0) * ds - me.s, L), tp = 0, dp = me.d;
    for (let j = 1, k = 1; j <= ev.n && k <= K; j++) {
      const x = wrap(line.idx(ev.i0 + j) * ds - me.s, L);
      while (k <= K && x >= k * p.dS) {
        const w = clamp((k * p.dS - xp) / Math.max(1e-6, x - xp), 0, 1);
        d[k] = dp + (this.lat[j] - dp) * w; t[k] = tp + (this.tAt[j] - tp) * w; cap[k] = this.cap[j]; k++;
      }
      xp = x; tp = this.tAt[j]; dp = this.lat[j];
    }
    return { d, t, cap };
  }
}
