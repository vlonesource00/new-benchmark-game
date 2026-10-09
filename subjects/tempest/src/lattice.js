import { clamp } from '../../apex/src/math.js';
import { at } from './forecast.js';
import { HALF_LEN } from './perception.js';
import { OFFSETS, LINE_LANE } from './atlas.js';
import { wetFrac, aquaplane } from '../../../game/engine/sim/water.js';

const MAXK = 48, M = OFFSETS.length;

/** C2 blend weight (smootherstep) and its second derivative. */
export const blend = (u) => u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (u * (6 * u - 15) + 10);
const blend2 = (u) => u <= 0 || u >= 1 ? 0 : 60 * u * (1 - u) * (1 - 2 * u);

/**
 * The start join: a quintic from the anchor (offset d0, slope p0, curvature c0 from the line) to offset sb with zero
 * slope and curvature, over L metres; returns the offset at u and writes its second derivative to J2[0].
 */
export const J2 = new Float64Array(1);
export function join(st, sb, L, u) {
  const u2 = u * u, u3 = u2 * u, u4 = u3 * u, u5 = u4 * u, c0 = st.c0 ?? 0;
  const h0 = 1 - 10 * u3 + 15 * u4 - 6 * u5, h1 = u - 6 * u3 + 8 * u4 - 3 * u5, h2 = 0.5 * u2 - 1.5 * u3 + 1.5 * u4 - 0.5 * u5;
  const g0 = -60 * u + 180 * u2 - 120 * u3, g1 = -36 * u + 96 * u2 - 60 * u3, g2 = 1 - 9 * u + 18 * u2 - 10 * u3;
  J2[0] = ((st.d0 - sb) * g0 + L * st.p0 * g1 + L * L * c0 * g2) / (L * L);
  return st.d0 * h0 + L * st.p0 * h1 + L * L * c0 * h2 + sb * (1 - h0);
}

/**
 * Length a lane change of `delta` metres needs at speed v so that its own curvature costs no more than `aT` m/s²
 * of lateral acceleration (smootherstep peak curvature is 5.77·Δ/L²).
 */
export const changeLength = (delta, v, aT) => clamp(Math.max(5, v) * Math.sqrt(5.77 * Math.abs(delta) / Math.max(1.5, aT)), 18, 220);

/**
 * Space-time lattice over the manoeuvre library. Layers every Δs metres ahead of the car; a node is "on library
 * lane m at layer k", carrying the best arrival time, speed and tow surplus found for it. Edges:
 *
 *   stay          one layer along lane m
 *   change a→b    a smootherstep transition spanning as many layers as the lane change needs at that speed
 *   start         from the car's own offset and lateral rate onto lane b (quintic join), the first edge of a plan
 *
 * Every layer an edge passes is priced the same way, in seconds:
 *
 *   travel        the lane's own speed (live line profile × the lane's QSS ratio from Atlas, × water grip), capped by
 *                 the transition's own curvature, by what the drive can add from the arrival speed, by the following
 *                 distance to any forecast car in the band, raised by tow on power-limited road, lowered by dirty air
 *   risk          forecast bodies with growing uncertainty: hard inside 0.7 s, priced and fading beyond it
 *   change        a small fixed price per lane change (no dithering for nothing)
 *   commitment    choosing a first lane other than the last plan's
 *   defence       an attacker close behind makes an open inside at the next braking zone cost what the attack is worth
 *   outcome       at the horizon: each same-class rival we are predicted to be ahead of (or behind) is worth ±B seconds
 *
 * The lattice proposes; the arbiter rolls the best few proposals out on the exact lane and profile the controller
 * would drive and decides on that (see rollout.js), so a plan is judged by the model that executes it.
 */
export class Lattice {
  constructor(driver) {
    this.driver = driver;
    const n = (MAXK + 1) * M;
    this.J = new Float64Array(n); this.T = new Float64Array(n); this.V = new Float64Array(n); this.E = new Float64Array(n);
    this.W = new Float32Array(n); this.PL = new Int8Array(n); this.PK = new Int16Array(n); this.F = new Int8Array(n);
    this.sh = new Float64Array(n); this.vl = new Float64Array(n); this.lf = new Float64Array(n);
    this.lay = { i: new Int32Array(MAXK + 1), f: new Float64Array(MAXK + 1), lat: new Float64Array(MAXK + 1), v: new Float64Array(MAXK + 1),
      corner: new Uint8Array(MAXK + 1), ks: new Float64Array(MAXK + 1) };
    this.stats = { plans: 0, edges: 0 };
  }
  plan(car, me, rivals, forecast, prev, opts = {}) {
    const d = this.driver, line = d.line, atlas = d.atlas, model = d.model, track = d.track, o = d.options;
    const v0 = Math.max(8, me.v);
    // horizon: 3.4 s of travel, always past the next apex when it is near
    let H = clamp(v0 * (o.horizonT ?? 3.4), 110, 320);
    const st0 = line.stationOf(me.s), i0 = Math.floor(st0);
    const zk = atlas.next[i0], zone = zk >= 0 ? atlas.zones[zk] : null;
    const toApex = zone ? atlas.ahead(i0, zone.apex) : Infinity;
    if (toApex < 380) H = clamp(Math.max(H, toApex + 30), 110, 400);
    const dS = clamp(v0 * 0.3, 7, 14), K = Math.min(MAXK, Math.ceil(H / dS));
    const lay = this.lay, sh = this.sh, VL = this.vl, LF = this.lf, lanes = atlas.lanes;
    const wet = track.water?.live && (track.wetness ?? 0) > 0.01;
    const tyre = car.wheels[2].tyre, hold = tyre.wetHold ?? 0, mean = wet ? d.meanWetGrip(car) : 1;
    for (let k = 0; k <= K; k++) {
      const st = line.stationOf(me.s + k * dS), i = Math.floor(st), f = st - i, j = line.idx(i + 1);
      lay.i[k] = i; lay.f[k] = f; lay.lat[k] = line.sample(line.lat, i, f, 0); lay.v[k] = line.sample(line.v, i, f, 0);
      lay.corner[k] = line.vmax[i] <= line.v[i] + 1.5 ? 1 : 0; lay.ks[k] = Math.abs(line.ks[i]);
      for (let m = 0; m < M; m++) {
        const L = lanes[m], s = L.shift[i] * (1 - f) + L.shift[j] * f;
        sh[k * M + m] = s;
        // path metres per metre of track on that lane (the line cuts corners, an outside lane runs long)
        LF[k * M + m] = (line.len[i] / line.ds) * (L.lenR[i] * (1 - f) + L.lenR[j] * f);
        let v = lay.v[k] * (L.ratio[i] * (1 - f) + L.ratio[j] * f);
        if (wet && k > 0) {
          // water grip under that lane, relative to what the live profile already assumes
          const c = atlas.cell[i] * 13 + track.laneAt(clamp(lay.lat[k] + s, -atlas.bound, atlas.bound)), mm = track.water.depth[c], rub = track.rubber?.[c] ?? 0;
          const g = (1 - wetFrac(mm) * (0.36 + rub * 0.2) * (1 - hold)) * (1 - 0.75 * aquaplane(mm, lay.v[k], tyre.aqV ?? 38, tyre.wear));
          v *= clamp(Math.sqrt(g / Math.max(0.3, mean)), 0.6, 1.12);
        }
        VL[k * M + m] = v;
      }
    }
    const mass = car.spec.mass + car.fuel * 0.75, wE = me.halfWidth ?? 0.98;
    const J = this.J, T = this.T, V = this.V, E = this.E, Wk = this.W, PL = this.PL, PK = this.PK, F = this.F;
    J.fill(Infinity, 0, (K + 1) * M);
    // the forecasts that can matter on this horizon
    const fs = [];
    for (const r of rivals) if (r.ds > -60 && r.ds < K * dS + 160) fs.push(forecast.of(r, me));
    // defence: a same-class attacker close behind, with a braking zone coming
    let defend = null;
    if (opts.defend !== false && zone && toApex < 300) {
      for (const r of rivals) {
        if (!r.target || r.mate || r.ds > -2 || r.ds < -40) continue;
        const closing = r.v - me.v, tgap = -r.ds / Math.max(10, r.v);
        if (tgap < 0.8 && (closing > -1 || -r.ds < 12) && zone.pass > 0.25) { defend = { r, zone, from: atlas.ahead(i0, zone.brake) - 80, to: atlas.ahead(i0, zone.brake) + 5 }; break; }
      }
    }
    const B = o.passValue ?? 0.45, colC = o.contactCost ?? 3, lam = o.commit ?? 0.01, swC = o.changeCost ?? 0.015;
    const brakeAt = (vv) => model.brake(Math.max(8, vv));
    const prevFirst = prev?.first ?? -1;
    const out = this.out ??= { v: 0, t: 0, e: 0, w: 0, cost: 0 };
    let edges = 0;
    // one layer of road: arrive at layer kb at lateral dB with lane speed vb, from (va, ta, ea); fills `out`, false = impossible
    const layer = (kb, dB, vb, ddel, va, ta, ea, lf) => {
      if (Math.abs(dB) > atlas.bound + 0.3) return false;
      const arc = Math.hypot(dS * lf, ddel);
      const vAcc = Math.sqrt(va * va + 2 * arc * Math.max(0.5, model.drive(va, mass)));
      let e = lay.corner[kb] ? 0 : ea * 0.9;
      let tb = ta + arc / Math.max(1, 0.5 * (va + Math.min(vb + e, vAcc)));
      let cost = 0, wake = 0, cap = Infinity;
      for (const f of fs) {
        const r = f.r, g = at(f.ds, tb) - kb * dS, rd = at(f.lat, tb), sg = at(f.sig, tb), sgs = at(f.sigS, tb), rv = at(f.v, tb);
        const Ls = HALF_LEN + r.halfLength, c = Math.abs(dB - rd) - (wE + r.across);
        if (Math.abs(g) < Ls + 0.5 * sgs) {
          const need = 0.15 + sg;
          if (c < need) {
            if (tb < 0.7 && c < 0.05) return false;                 // certain contact: not a plan
            const risk = clamp((need - c) / (sg + 0.3), 0, 1), conf = Math.exp(-Math.max(0, tb - 0.6) / 1.5);
            cost += colC * risk * conf * (r.hazard ? 2 : 1) * (1 + Math.abs(vb - rv) / 6);
          } else if (c < 0.6) cost += 0.06 * (0.6 - c);              // racing close: allowed, priced a little
        } else if (g > 0 && g < 90 && c < 0.35 + 0.4 * sg) {
          // a car ahead in our band: we go no faster than braking behind it allows
          const room = g - Ls - 0.8 - 0.25 * sgs - 0.15 * Math.max(0, vb - rv);
          cap = Math.min(cap, rv + Math.sqrt(2 * 0.55 * brakeAt(rv) * Math.max(0, room)));
        }
        if (g > Ls && g < 45 && Math.abs(dB - rd) < 1.6 && !r.hazard) wake = Math.max(wake, (1 - g / 45) * (1 - Math.abs(dB - rd) / 1.6));
      }
      if (wake > 0.02) {
        if (lay.corner[kb]) vb *= model.wakeSpeed(vb, wake);
        else e = Math.min(4, e + model.towGain(vb, wake) * (tb - ta));
      }
      const vNew = Math.min(vb + e, vAcc, cap);
      // the brakes have to make it: a speed drop beyond them is a collision or an off in waiting
      const need = (va * va - vNew * vNew) / (2 * arc), bk = brakeAt(va);
      if (need > bk * 1.08) cost += 0.5 + (need - bk) * 0.08;
      tb = ta + arc / Math.max(1, 0.5 * (va + vNew));
      // off the line costs options (and the clean line): seconds per metre-second away from it
      cost += (tb - ta) * (1 + (o.offline ?? 0.004) * Math.abs(dB - lay.lat[kb]));
      if (defend) {
        const sk = kb * dS;
        if (sk > defend.from && sk < defend.to) cost += (o.defendCost ?? 0.03) * clamp((atlas.bound - dB * defend.zone.inside - 2.4) / 2.5, 0, 1);
      }
      out.v = vNew; out.t = tb; out.e = vNew > vb ? Math.min(4, e) : e; out.w = wake; out.cost = cost;
      return true;
    };
    // the transition's own curvature caps the lane speed: v² · |κ_line + shift''| within the tyres' lateral grip
    const capFor = (k, v, s2) => s2 === 0 ? v : Math.min(v, Math.sqrt(model.lat(v) / Math.max(1e-6, lay.ks[k] + Math.abs(s2))));
    const relaxSpan = (kA, a, b, n, ja, va, ta, ea, first, start) => {
      // start: { d0, p0 } quintic join from the car; otherwise a smootherstep from lane a to lane b
      let v = va, t = ta, e = ea, J0 = ja, w = 0, dPrev = start ? start.d0 : sh[kA * M + a];
      const L = n * dS;
      for (let q = 1; q <= n; q++) {
        const kb = kA + q, u = q / n;
        const sb = sh[kb * M + b];
        let s, s2;
        if (start) { s = join(start, sb, L, u); s2 = J2[0]; } else {
          const sa = sh[kb * M + a], wq = blend(u);
          s = sa * (1 - wq) + sb * wq; s2 = (sb - sa) * blend2(u) / (L * L);
        }
        const vb = capFor(kb, Math.min(VL[kb * M + a], VL[kb * M + b]), s2);
        edges++;
        if (!layer(kb, lay.lat[kb] + s, vb, s - dPrev, v, t, e, 0.5 * (LF[kb * M + a] + LF[kb * M + b]))) return;
        J0 += out.cost; v = out.v; t = out.t; e = out.e; w = Math.max(w, out.w); dPrev = s;
      }
      const kE = kA + n, idx = kE * M + b, total = J0 + (start ? 0 : swC);
      if (total < J[idx]) { J[idx] = total; T[idx] = t; V[idx] = v; E[idx] = e; Wk[idx] = w; PL[idx] = start ? -1 : a; PK[idx] = start ? -1 : kA; F[idx] = first; }
    };
    // start edges: from the car's offset and lateral rate onto every lane
    const lat0 = lay.lat[0], latSlope = (line.sample(line.lat, lay.i[0], lay.f[0], 4) - line.sample(line.lat, lay.i[0], lay.f[0], -4)) / 8;
    // the plan continues the committed path (where the car is meant to be), not the car's measured drift: the
    // controller corrects the drift; a plan re-anchored on it every 0.1 s would adopt it. Off the path: from the car.
    const start = opts.anchor ?? { d0: me.d - lat0, p0: clamp(me.vl / v0 - latSlope, -0.25, 0.25) };
    const aT = (k) => { const lat = model.lat(v0), ay = v0 * v0 * lay.ks[k]; return Math.max(1.5, (o.changeShare ?? 0.6) * Math.sqrt(Math.max(0, lat * lat - ay * ay))); };
    const n0 = this.n0 ??= new Int16Array(M);
    for (let b = 0; b < M; b++) {
      const delta = Math.abs(sh[M + b] - start.d0) + Math.abs(start.p0) * 20;
      // the transition being driven keeps its remaining length: a replan reproduces it instead of restarting it
      const keep = start.keep && start.keep.lane === b ? start.keep.rem : 0;
      const n = n0[b] = clamp(Math.ceil((keep > 0 ? keep : changeLength(delta, v0, aT(1))) / dS), 1, K);
      const commit = prevFirst >= 0 ? lam * Math.abs(OFFSETS[b] - OFFSETS[prevFirst]) : 0;
      relaxSpan(0, b, b, n, commit, v0, 0, Math.max(0, me.v - lay.v[0]), b, start);
    }
    for (let k = 1; k < K; k++) {
      for (let a = 0; a < M; a++) {
        const ia = k * M + a, ja = J[ia];
        if (ja === Infinity) continue;
        const va = V[ia], ta = T[ia], ea = E[ia], first = F[ia];
        relaxSpan(k, a, a, 1, ja, va, ta, ea, first, null);
        for (let b = 0; b < M; b++) {
          if (b === a) continue;
          const delta = Math.abs(sh[k * M + b] - sh[k * M + a]);
          if (delta < 0.3) continue;   // lanes merged here (both clamped at the edge): stay covers it
          const n = Math.ceil(changeLength(delta, va, aT(k)) / dS);
          if (k + n > K) continue;
          relaxSpan(k, a, b, n, ja, va, ta, ea, first, null);
        }
      }
    }
    // outcome at the horizon; the best terminal per first lane, so the arbiter can roll out distinct first moves
    const bestByFirst = new Array(M).fill(null);
    for (let b = 0; b < M; b++) {
      const idx = K * M + b; if (J[idx] === Infinity) continue;
      let jt = J[idx]; const tK = T[idx];
      for (const f of fs) {
        const r = f.r; if (!r.target || r.mate) continue;
        const g0 = r.ds, gE = at(f.ds, tK) - K * dS, Ls = HALF_LEN + r.halfLength;
        if (g0 > -Ls && gE < -0.6 * Ls) jt -= B;              // a place taken
        else if (g0 < 0 && gE > -0.3 * Ls) jt += B;           // a place lost
      }
      jt += (o.rejoin ?? 0.006) * Math.abs(OFFSETS[b]);
      const fl = F[idx];
      if (!bestByFirst[fl] || jt < bestByFirst[fl].score) bestByFirst[fl] = { score: jt, b };
    }
    this.stats.plans++; this.stats.edges = edges;
    const props = bestByFirst.filter(Boolean).sort((x, y) => x.score - y.score).map(({ score, b }) => this.extract(K, dS, b, score, me, start));
    // the racing line itself is always a proposal: the DP keeps one label per node, so near-ties can erase it
    if (!props.some((x) => x.first === LINE_LANE && x.last === LINE_LANE && x.segs.length === 1))
      props.push({ score: NaN, last: LINE_LANE, first: LINE_LANE, segs: [{ k0: 0, k1: n0[LINE_LANE], lane: LINE_LANE }], tK: NaN, vK: NaN, tow: 0, s0: me.s, dS, K, forced: true });
    if (!props.length) return null;
    return { s0: me.s, dS, K, props, fs, defend: defend?.r.id ?? null, defendZone: defend ? { from: defend.from, to: defend.to, inside: defend.zone.inside } : null, edges, start };
  }
  /** Backtrack the node chain ending on lane b at layer K into segments: [{ k0, k1, lane }] (transition k0→k1 into lane). */
  extract(K, dS, b, score, me, start) {
    const segs = []; let k = K, lane = b, guard = 0;
    while (k > 0 && guard++ < 200) {
      const idx = k * M + lane, pk = this.PK[idx], pl = this.PL[idx];
      if (pk < 0) { segs.push({ k0: 0, k1: k, lane }); break; }
      if (pl !== lane) segs.push({ k0: pk, k1: k, lane });
      k = pk; lane = pl;
    }
    segs.reverse();
    // the start join may be swallowed by stays; make the first segment the start edge
    if (!segs.length || segs[0].k0 !== 0) segs.unshift({ k0: 0, k1: 1, lane: segs[0]?.lane ?? b });
    return { score, last: b, first: segs[0].lane, segs, tK: this.T[K * M + b], vK: this.V[K * M + b], tow: this.W[K * M + b], s0: me.s, dS, K };
  }
}
