// PHANTOM planner: sampled control sequences scored by the exact plant.
//
// The planning object is a short sequence of control knots (steer, pedal),
// not a path or a speed profile. Each candidate is executed on a private copy
// of the car through the benchmark's own Vehicle integrator, on a read-only
// view of the track, next to predicted opponent boxes. Whatever line, brake
// point, slide or slipstream falls out of that execution is what gets scored:
//   value     ghost time covered (how far ahead of the best recorded lap the
//             candidate ends up), plus the lap time its terminal speed is
//             still worth before the next apex;
//   limits    track-limit penalty on the car centre, a brakeability envelope
//             for the corners beyond the horizon, terminal stability;
//   tyres     sliding energy priced by each tyre's core temperature;
//   traffic   box contact with predicted opponents, and a small reward for
//             covering an attacker's line when defending.
// The best candidates are blended MPPI-style and warm-start the next cycle.

import { RolloutTrack, makeShadow, copyVehicle } from './plant.js';
import { tyrePrice, axleGrip } from './tyre-price.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULTS = {
  K: 40, iterations: 1, horizon: 2.0, knotDt: 0.1, fineDt: 1 / 120, fineTime: 0.2, dt: 1 / 60,
  edge: 8.2, edgeMargin: 0.3, sigmaSteer: 0.08, sigmaPedal: 0.25, rho: 0.7,
  tempMin: 0.002, tyreScale: 1, lapsLeft: 5, capMargin: 0, capWeight: 2, capQuad: 0.8, edgeLook: 0.5, edgeWeight: 0.5, policyOffsets: [0, -2.5, 2.5],
  defendWeight: 0.03, heatBase: 2e-3, gripExp: 0, slipCap: 2.3, slipWeight: .3, tcSlip: 1.2, lineWeight: 0.06, lineDead: 1.5, slideDead: 0.06, slideGain: 1, recoverAcc: 7, seed: 7
};

export class Planner {
  constructor(track, car, ghost, field, options = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.track = track; this.ghost = ghost; this.field = field;
    this.proxy = new RolloutTrack(track);
    this.shadow = makeShadow(car);
    this.rand = mulberry32(this.o.seed);
    this.lock = car.spec.steeringLock; this.wheelbase = car.spec.wheelbase;
    this.buildSchedule();
    this.buildPath();
    const N = this.N, K = this.o.K;
    this.steer = new Float32Array(N); this.pedal = new Float32Array(N);
    this.sSteer = new Float32Array(K * N); this.sPedal = new Float32Array(K * N);
    this.cost = new Float64Array(K);
    this.meanSteer = new Float32Array(N); this.meanPedal = new Float32Array(N);
    this.tmpSteer = new Float32Array(N); this.tmpPedal = new Float32Array(N);
    this.hasPlan = false;
    this.stats = { plans: 0, best: 0, value: 0, offtrack: 0, contact: 0 };
    this.trace = null; // optional: filled with the chosen rollout
    this.lens = null;  // optional: {candidates: [{pts, cost, contact, off}]} for the debugger
  }

  buildSchedule() {
    const o = this.o, dts = [], times = [];
    let t = 0;
    while (t < o.horizon - 1e-9) {
      const h = t < o.fineTime - 1e-9 ? o.fineDt : o.dt;
      t += h; dts.push(h); times.push(t);
    }
    this.dts = Float32Array.from(dts); this.times = Float32Array.from(times);
    this.N = Math.ceil(o.horizon / o.knotDt) + 2;
  }

  // The ghost's world path, indexed by lap distance. Track stations are not
  // evenly spaced on the road (the centreline folds through some corners),
  // so look-ahead and heading are measured along this path's arc length.
  buildPath() {
    const g = this.ghost, n = g.n, px = new Float32Array(n), pz = new Float32Array(n);
    for (let i = 0; i < n; i++) { const p = this.track.at(g.origin + i * g.ds, g.q[i]); px[i] = p.x; pz[i] = p.z; }
    const arc = new Float64Array(n + 1), tx = new Float32Array(n), tz = new Float32Array(n);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; arc[i + 1] = arc[i] + Math.hypot(px[j] - px[i], pz[j] - pz[i]); }
    this.path = { px, pz, arc, tx, tz, len: arc[n] };
    for (let i = 0; i < n; i++) {
      const a = this.pathIndex(arc[i] - 3), b = this.pathIndex(arc[i] + 3);
      const ia = Math.round(a) % n, ib = Math.round(b) % n;
      const dx = px[ib] - px[ia], dz = pz[ib] - pz[ia], d = Math.hypot(dx, dz) || 1;
      tx[i] = dx / d; tz[i] = dz / d;
    }
    // How far off the road the ghost itself points at each station, by the
    // same straight-ahead probe the terminal cost uses. Entering a tight
    // corner, even the fastest line aims past the edge; only aiming further
    // out than that is a bad entry.
    const pred = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const look = Math.max(8, 0.5 * g.v[i]);
      this.proxy.locate(px[i], pz[i]);
      pred[i] = Math.abs(this.proxy.surface(px[i] + tx[i] * look, pz[i] + tz[i] * look).lateral);
    }
    this.path.pred = pred;
  }

  // Fractional lap distance at world arc length a (wrapped).
  pathIndex(a) {
    const { arc, len } = this.path, n = this.ghost.n;
    a = ((a % len) + len) % len;
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arc[m] <= a) lo = m; else hi = m; }
    return (lo + (a - arc[lo]) / Math.max(1e-6, arc[lo + 1] - arc[lo])) * this.ghost.ds;
  }

  pathArc(u) {
    const g = this.ghost, x = (((u % g.length) + g.length) % g.length) / g.ds, i = Math.floor(x);
    return this.path.arc[i] + (this.path.arc[i + 1] - this.path.arc[i]) * (x - i);
  }

  // Warm start: re-anchor the previous plan at the new plan time.
  shift(elapsed) {
    const N = this.N, kd = this.o.knotDt;
    for (let i = 0; i < N; i++) {
      const x = Math.min(N - 1, i + elapsed / kd), j = Math.floor(x), f = x - j, j1 = Math.min(N - 1, j + 1);
      this.tmpSteer[i] = this.steer[j] + (this.steer[j1] - this.steer[j]) * f;
      this.tmpPedal[i] = this.pedal[j] + (this.pedal[j1] - this.pedal[j]) * f;
    }
    this.steer.set(this.tmpSteer); this.pedal.set(this.tmpPedal);
  }

  controlAt(tau) {
    const x = clamp(tau / this.o.knotDt, 0, this.N - 1.0001), j = Math.floor(x), f = x - j;
    return {
      steer: this.steer[j] + (this.steer[j + 1] - this.steer[j]) * f,
      pedal: this.pedal[j] + (this.pedal[j + 1] - this.pedal[j]) * f
    };
  }

  // One rollout. `policy` null: open loop on knots (st, pe at offset base).
  // policy {kind:'pursuit', offset, factor} or {kind:'replay'}: closed loop;
  // the applied controls are written back into the knots.
  rollout(car, st, pe, base, policy, ctx, trace = null) {
    const o = this.o, g = this.ghost, sh = this.shadow, proxy = this.proxy, field = this.field;
    copyVehicle(sh, car);
    const rec = !trace && ctx.lens ? { pts: [], cost: 0, contact: 0, off: 0 } : null;
    if (rec) { trace = rec.pts; ctx.lens.push(rec); }
    proxy.hint = ctx.hint;
    const L = this.track.length, kd = o.knotDt, N = this.N;
    let du = 0, prevS = car.s, t = 0, cost = 0, off = 0, contact = 0;
    const prices = ctx.prices, hasField = field && field.list.length > 0;
    let nextKnot = 0;
    for (let k = 0; k < this.dts.length; k++) {
      const h = this.dts[k];
      let steer, pedal;
      if (policy) {
        if (policy.kind === 'replay') {
          const u = ctx.u0 + du;
          steer = g.sample(g.steer, u); pedal = g.sample(g.pedal, u);
        } else {
          ({ steer, pedal } = this.pursuit(sh, ctx.u0 + du, policy, hasField ? k : -1));
        }
        while (nextKnot < N && nextKnot * kd <= t + 1e-9) { st[base + nextKnot] = steer; pe[base + nextKnot] = pedal; nextKnot++; }
      } else {
        const x = Math.min(t / kd, N - 1.0001), j = Math.floor(x), f = x - j;
        steer = st[base + j] + (st[base + j + 1] - st[base + j]) * f;
        pedal = pe[base + j] + (pe[base + j + 1] - pe[base + j]) * f;
      }
      sh.controls.steer = this.stabilise(sh, steer);
      sh.controls.throttle = pedal > 0 ? pedal : 0;
      sh.controls.brake = pedal < 0 ? -pedal : 0;
      const wake = hasField ? field.wake(k, sh.x, sh.z) : 0;
      sh.step(h, proxy, wake);
      t += h;
      let d = sh.s - prevS; if (d > L / 2) d -= L; else if (d < -L / 2) d += L;
      du += d; prevS = sh.s;
      const lat = Math.abs(sh.lateral), soft = o.edge - o.edgeMargin;
      if (lat > soft) {
        const hard = lat > o.edge;
        // Already off at plan start: only getting further out is a new cost,
        // so rejoining the road stays the cheapest thing to do.
        cost += h * ((hard && !ctx.startOff ? 30 : 0) + 25 * (lat - soft));
        if (hard) off += h;
      }
      const w = sh.wheels;
      // Slip angles and ratios are ill-defined at a crawl; tyre costs fade in
      // with speed so pulling away is never priced above standing still.
      const fade = Math.min(1, Math.max(0, (sh.speed - 8) / 10));
      cost += fade * h * 1e-3 * (prices[0] * w[0].tyre.slipPower + prices[1] * w[1].tyre.slipPower + prices[2] * w[2].tyre.slipPower + prices[3] * w[3].tyre.slipPower);
      // Slip beyond the force peak buys no grip, only heat, and is the first
      // step of a lockup or spin: price it by how far past the peak it runs.
      if (fade > 0) for (let i = 0; i < 4; i++) {
        const ty = w[i].tyre, sl = Math.hypot(ty.kappa * 10.5, Math.tan(ty.alpha) * 8.6) - o.slipCap;
        if (sl > 0) cost += h * fade * o.slipWeight * sl * sl;
      }
      if (hasField) {
        const c = field.contact(k, sh.x, sh.z, sh.yaw);
        if (c > 0) { cost += h * (40 + 150 * c) / (1 + 0.5 * t); contact += h; }
        else if (c > -0.35) cost += h * 0.3 * (c + 0.35);
        if (ctx.defend) cost -= h * o.defendWeight * field.cover(k, sh.x, sh.z, sh.yaw);
      }
      if (trace) trace.push(sh.x, sh.z, sh.speed, sh.lateral);
    }
    if (policy) while (nextKnot < N) { st[base + nextKnot] = st[base + nextKnot - 1]; pe[base + nextKnot] = pe[base + nextKnot - 1]; nextKnot++; }
    // Terminal value.
    const run0 = cost;
    const uT = ctx.u0 + du;
    const value = g.clock(uT) - ctx.clock0;
    const vT = sh.speed, vg = Math.max(10, g.speed(uT));
    const cap = g.capAt(uT) * ctx.capScale + o.capMargin;
    // Speed carried past the horizon is worth lap time only up to what the
    // next corner lets the car keep.
    // A deficit is also lost time however close the apex is: it has to be
    // driven back up, costing about deficit^2 / (2 a v) seconds. Without this
    // a horizon ending at an apex prices crawling there the same as carrying
    // the ghost speed, and the car stops before corners.
    const deficit = Math.max(0, vg - vT);
    const bonus = Math.min(clamp(0.5 * g.apexLead(uT) * (Math.min(vT, cap) - vg) / vg, -1, 1),
      -Math.min(3, deficit * deficit / (2 * o.recoverAcc * vg)));
    if (vT > cap) cost += o.capWeight * (vT - cap) + o.capQuad * (vT - cap) ** 2;
    const ip = Math.round(this.ghost.lapDistance(sh.s) / g.ds) % g.n, ptx = this.path.tx[ip], ptz = this.path.tz[ip];
    // Where the car is pointed matters beyond the horizon: a car aimed at
    // the edge, or turned across the road, has little future left.
    const fx = Math.sin(sh.yaw), fz = Math.cos(sh.yaw);
    const headLat = fx * ptz - fz * ptx, headFwd = fx * ptx + fz * ptz;
    // Project the car straight on in world space, along its heading and its
    // velocity, and ask the road where that point lies. Measuring in the
    // track frame instead reads every chicane as a trip into the wall.
    const look = Math.max(8, 0.5 * vT), vn = Math.max(1, Math.hypot(sh.vx, sh.vz)), vl = look / vn;
    const pred = Math.max(Math.abs(proxy.surface(sh.x + fx * look, sh.z + fz * look).lateral),
      Math.abs(proxy.surface(sh.x + sh.vx * vl, sh.z + sh.vz * vl).lateral));
    const allow = Math.max(o.edge, this.path.pred[ip] + 1);
    if (pred > allow) cost += o.edgeWeight * (pred - allow) ** 2;
    // The corner after the horizon is set up by where the car ends up across
    // the road: far off the ghost's line is a worse entry than the clock sees.
    const dq = Math.abs(sh.lateral - g.lateral(uT)) - o.lineDead * (ctx.combat ? 3 : 1);
    if (dq > 0) cost += o.lineWeight * dq * dq;
    const headErr = Math.abs(Math.atan2(headLat, headFwd));
    if (headErr > 0.35) cost += 3 * (headErr - 0.35) ** 2;
    const beta = Math.abs(Math.atan2(sh.v, Math.max(5, sh.u)));
    if (beta > 0.1) cost += 5 * (beta - 0.1) ** 2;
    if (ctx.lastStats) { ctx.lastStats.value = value; ctx.lastStats.off = off; ctx.lastStats.contact = contact; ctx.lastStats.vT = vT; ctx.lastStats.cap = cap; }
    const J = cost - value - bonus;
    if (this.dbg) this.dbg.push({ kind: policy ? (policy.kind + (policy.offset ?? '') + 'x' + (policy.factor ?? '') + (policy.hold != null ? 'h' : '')) : 'knots', J, run: run0, term: cost - run0, value, bonus, vT, cap, uT, off, contact, headErr, beta, pred, x: sh.x, z: sh.z, lat: sh.lateral, yawd: sh.yaw * 57.3, vx: sh.vx, vz: sh.vz });
    if (rec) { rec.cost = J; rec.contact = contact; rec.off = off; }
    return J;
  }

  // Yaw-stability loop shared by every rollout and by playback on the real
  // car: body slip past the deadband adds countersteer, so open-loop knot
  // samples that step the rear out catch it instead of spinning.
  stabilise(car, steer) {
    const cs = Math.cos(car.yaw), sn = Math.sin(car.yaw);
    const vf = car.vx * sn + car.vz * cs, vs = car.vx * cs - car.vz * sn;
    if (car.speed < 8 || vf < 1) return steer;
    const b = Math.atan2(vs, vf), ex = Math.abs(b) - this.o.slideDead;
    return ex > 0 ? clamp(steer + Math.sign(b) * ex * this.o.slideGain / this.lock, -1, 1) : steer;
  }

  // Closed-loop seed policy: pure pursuit of the ghost's lateral offset (plus
  // an offset), tracking the ghost's speed scaled by a factor.
  pursuit(sh, u, { offset = 0, factor = 1, rejoin = false, hold = null }, k = -1) {
    const g = this.ghost, look = Math.max(rejoin ? 14 : 9, sh.speed * 0.5);
    const uAt = this.pathIndex(this.pathArc(u) + look);
    const q = rejoin ? 0 : hold !== null ? hold : clamp(g.lateral(uAt) + offset, -this.o.edge + 1.2, this.o.edge - 1.2);
    const p = this.track.at(g.origin + uAt, q);
    const dx = p.x - sh.x, dz = p.z - sh.z;
    const cs = Math.cos(sh.yaw), sn = Math.sin(sh.yaw);
    const fwd = dx * sn + dz * cs, side = dx * cs - dz * sn;
    // Aim along the velocity, not the body: a sliding car then gets the
    // countersteer it needs instead of more lock into the slide.
    const vf = sh.vx * sn + sh.vz * cs, vs = sh.vx * cs - sh.vz * sn;
    const slide = sh.speed > 5 ? clamp(Math.atan2(vs, Math.max(1, vf)), -0.5, 0.5) : 0;
    const alpha = Math.atan2(side, Math.max(1, fwd)) - slide;
    const delta = Math.atan(2 * this.wheelbase * Math.sin(alpha) / Math.hypot(dx, dz)) + slide;
    let target = g.speed(u + sh.speed * 0.25) * factor;
    if (k >= 0) target = Math.min(target, this.field.follow(k, sh.x, sh.z, Math.atan2(sh.vx, sh.vz), sh.speed));
    let pedal = clamp((target - sh.speed) * 0.6, -1, 1);
    // Traction control and ABS on the shadow's own tyres: a pedal that runs
    // the driven or braking axle past the force peak is eased back, so the
    // fast seeds carry speed through a corner instead of spinning in it.
    const w = sh.wheels, slip = (i) => Math.hypot(w[i].tyre.kappa * 10.5, Math.tan(w[i].tyre.alpha) * 8.6);
    // Slip ratios are ill-defined at a crawl, so the cut fades in with speed.
    const tc = this.o.tcSlip, fade = clamp((sh.speed - 8) / 10, 0, 1);
    if (pedal > 0) pedal *= 1 - fade * (1 - clamp(1 - (Math.max(slip(2), slip(3)) - tc) / 0.8, 0, 1));
    else if (pedal < 0) pedal *= 1 - fade * (1 - clamp(1 - (Math.max(slip(0), slip(1), slip(2), slip(3)) - tc) / 0.8, 0.3, 1));
    return { steer: clamp(delta / this.lock, -1, 1), pedal };
  }

  plan(car, now, { defend = false, combat = false } = {}) {
    const o = this.o, g = this.ghost, N = this.N, K = o.K;
    if (this.hasPlan) this.shift(now - this.planTime); else { this.steer.fill(car.controls.steer || 0); this.pedal.fill(0.5); }
    const hint = this.proxy.locate(car.x, car.z);
    const u0 = g.lapDistance(car.s);
    const ctx = { hint, u0, clock0: g.clock(u0), capScale: Math.pow(axleGrip(car), o.gripExp), prices: car.wheels.map((w) => o.heatBase + tyrePrice(w.tyre.core, o.tyreScale)), defend, combat, lastStats: null, lens: this.lens ? [] : null,
      startOff: Math.abs(car.lateral) > o.edge };
    const st = this.sSteer, pe = this.sPedal, cost = this.cost;
    let n = 0;
    // Structured candidates.
    st.set(this.steer, 0); pe.set(this.pedal, 0); cost[n] = this.rollout(car, st, pe, 0, null, ctx); n++;
    const offsets = combat ? [...o.policyOffsets, -5, 5] : o.policyOffsets;
    for (const off of offsets) { cost[n] = this.rollout(car, st, pe, n * N, { kind: 'pursuit', offset: off, factor: 1 }, ctx); n++; }
    cost[n] = this.rollout(car, st, pe, n * N, { kind: 'pursuit', offset: 0, factor: 1.05 }, ctx); n++;
    cost[n] = this.rollout(car, st, pe, n * N, { kind: 'pursuit', offset: 0, factor: 0.9 }, ctx); n++;
    // Rescue candidates: shed speed while holding the current lane, pulled
    // back inside the road. They matter when grip has fallen below the
    // ghost's and every ghost-paced plan runs wide.
    // In traffic, fixed lanes across the road as well: the way past a queue
    // is often nowhere near the ghost line.
    if (combat) for (const q of [-4.5, 0, 4.5]) { cost[n] = this.rollout(car, st, pe, n * N, { kind: 'pursuit', hold: q, factor: 1 }, ctx); n++; }
    const holdQ = clamp(car.lateral, -o.edge + 2, o.edge - 2);
    cost[n] = this.rollout(car, st, pe, n * N, { kind: 'pursuit', hold: holdQ, factor: 0.8 }, ctx); n++;
    cost[n] = this.rollout(car, st, pe, n * N, { kind: 'pursuit', offset: 0, factor: 0.75 }, ctx); n++;
    if (ctx.startOff || car.speed < 8) { cost[n] = this.rollout(car, st, pe, n * N, { kind: 'pursuit', offset: 0, factor: 0.5, rejoin: true }, ctx); n++; }
    if (g.hasControls) { cost[n] = this.rollout(car, st, pe, n * N, { kind: 'replay' }, ctx); n++; }
    const structured = n;
    for (let it = 0; it < o.iterations; it++) {
      // Centre the noise on the best candidate so far.
      let bi = 0; for (let i = 1; i < n; i++) if (cost[i] < cost[bi]) bi = i;
      const cs = this.tmpSteer, cp = this.tmpPedal;
      for (let j = 0; j < N; j++) { cs[j] = st[bi * N + j]; cp[j] = pe[bi * N + j]; }
      const count = it === 0 ? K - structured : Math.floor(K / 2);
      const start = it === 0 ? structured : 1;
      for (let m = 0; m < count; m++) {
        const i = start + m; if (i >= K) break;
        const b = i * N, scale = m % 4 === 3 ? 2.2 : 1;
        let es = 0, ep = 0;
        const r = o.rho, q = Math.sqrt(1 - r * r);
        for (let j = 0; j < N; j++) {
          es = r * es + q * gauss(this.rand) * o.sigmaSteer * scale;
          ep = r * ep + q * gauss(this.rand) * o.sigmaPedal * scale;
          st[b + j] = clamp(cs[j] + es, -1, 1); pe[b + j] = clamp(cp[j] + ep, -1, 1);
        }
        cost[i] = this.rollout(car, st, pe, b, null, ctx);
        if (it === 0) n = i + 1;
      }
      if (it > 0) n = K;
      // Keep the incumbent best at slot 0 for the next iteration.
      let best = 0; for (let i = 1; i < n; i++) if (cost[i] < cost[best]) best = i;
      if (best !== 0) { st.copyWithin(0, best * N, best * N + N); pe.copyWithin(0, best * N, best * N + N); cost[0] = cost[best]; }
    }
    // MPPI blend.
    const sorted = Array.from(cost.subarray(0, n)).sort((a, b) => a - b);
    const jmin = sorted[0], lam = Math.max(o.tempMin, 0.3 * (sorted[Math.floor(n / 4)] - jmin));
    const ms = this.meanSteer, mp = this.meanPedal;
    ms.fill(0); mp.fill(0);
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.exp(-(cost[i] - jmin) / lam); wsum += w;
      for (let j = 0; j < N; j++) { ms[j] += w * st[i * N + j]; mp[j] += w * pe[i * N + j]; }
    }
    for (let j = 0; j < N; j++) { ms[j] /= wsum; mp[j] /= wsum; }
    const meanCost = this.rollout(car, ms, mp, 0, null, ctx);
    if (meanCost <= cost[0]) { this.steer.set(ms); this.pedal.set(mp); this.stats.best = meanCost; }
    else { this.steer.set(st.subarray(0, N)); this.pedal.set(pe.subarray(0, N)); this.stats.best = cost[0]; }
    if (this.trace) { this.trace.length = 0; ctx.lastStats = this.stats; this.rollout(car, this.steer, this.pedal, 0, null, ctx, this.trace); }
    if (this.lens) { this.lens.candidates = ctx.lens; this.lens.mean = ctx.lens.at(-1); this.lens.time = now; }
    this.planTime = now; this.hasPlan = true; this.stats.plans++;
    return this.stats;
  }
}

function gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
