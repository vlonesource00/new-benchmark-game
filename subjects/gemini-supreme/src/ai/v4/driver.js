/**
 * Gemini Supreme v4 — native driver.
 *
 * Layers (see DESIGN.md):
 *   RacePlan (offline line + g-g-v) → live SpeedProfile rescaled by tyre state
 *   → Frenet traffic layer (offset + speed cap) → cascaded lateral/yaw tracker.
 * Acts only through car.controls {throttle, brake, steer}.
 */

import { RacePlan } from './plan.js';
import { SpeedProfile } from './profile.js';
import { tyreThermalFactor } from './envelope.js';
import { TrafficLayer } from './traffic.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const angle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const DEFAULT_OPTIONS = Object.freeze({
  // plan
  // qMax null: track half-width minus edgeMargin. 1.7 left no room for tracking error:
  // running 2 m wide while braking at 240 km/h put the outer wheels on the 0.88-grip
  // kerb and spun the car (Solenne 700 m, Desert 2700 m); 2.2 is clean and no slower.
  // relax*: elastic-band passes that straighten centreline kinks (1200 left Harbor Ring's
  // 860 m kink at R 39 m; 4000 takes ~0.7 s off the planned lap)
  ds: 2, qMax: null, edgeMargin: 2.2, lineBudgetMs: 2500, relaxIters: 4000, relaxMs: 3000, envelope: null,
  // tracker
  // kb: countersteer into body slip past betaDead; it holds slides the old kb 0 spun out of
  tau: 0.085, ffLead: 0.10, kUs: 0.0, kpE: 1.4, kdE: 2.2, kr: 1.0, kb: 0.6, betaDead: 0.08, latHead: 1.15,
  vLead: 0.08, kv: 6, brakeGain: 1 / 27,
  // throttle governor: slip angle / rear slip ratio above which drive is cut
  // (0.09 rear slip is only ~74 % of the tyre's drive force; it held throttle back on half the lap)
  betaCut: 0.10, betaGain: 10, brakeBetaGain: 8, slipCut: 0.16, slipGain: 6,
  // tyre model
  gripTrim: 1.05, replanEvery: 0.5, util: 1.0, hotUtil: 0.94, hotCore: 100, hotSpan: 20,
  // recovery (off the road or pointing the wrong way)
  recLat: 8.8, recEc: 0.9, recSpeed: 14,
  // adaptive slip map: body slip above learnBeta trims the local speed for later
  // laps (window learnBack m before .. learnAhead m after); calm passes give it back
  learn: true, learnBeta: 0.10, learnRate: 0.25, learnFloor: 0.9, learnBack: 120, learnAhead: 12, learnGive: 0.0015, learnHitBeta: 0.2, learnHitCut: 0.035,
  // traffic
  // offset path: lateral utilisation and braking assumed for the tightened reference
  traffic: true, offSlow: 0.012, offUtil: 0.96, offBrake: 9,
  wakeSlow: 0.06, settleE: 0.9, settleBeta: 0.08
});

export class GeminiV4Driver {
  constructor({ track, car, options = {} }) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    const o = this.options;
    o.qMax ??= Math.max(4, track.halfWidth - o.edgeMargin);
    o.recLat = Math.min(o.recLat, track.halfWidth + (track.curbWidth ?? 1) - 0.3);
    o.passMax ??= o.qMax;
    this.track = track;
    this.spec = car.spec;
    this.plan = RacePlan.get(track, car.spec, { ds: o.ds, qMax: o.qMax, lineBudgetMs: o.lineBudgetMs, relaxIters: o.relaxIters, relaxMs: o.relaxMs, envelope: o.envelope });
    this.env = this.plan.envelope;
    this.profile = new SpeedProfile(this.plan.n);
    this.grip = 1; this.util = o.util;
    this.replanAt = -1;
    this.offset = 0; this.offsetRate = 0;
    this.trim = new Float64Array(this.plan.n).fill(1);
    this.lastNode = -1; this.slideAt = -1; this.hitOn = false;
    this.traffic = o.traffic ? new TrafficLayer(this, o) : null;
    this.dbg = {};
  }

  replan(car, time) {
    const o = this.options;
    const f = car.wheels.reduce((a, w) => a + tyreThermalFactor(w.tyre), 0) / 4;
    // Hot threshold is relative to the compound's window (host tyres: 85 C).
    const hottest = Math.max(...car.wheels.map((w) => w.tyre.core - (w.tyre.optimum ?? 85) + 85));
    this.grip = f * o.gripTrim;
    // Past the hot threshold, run progressively below the limit (slip power falls
    // faster than grip). Continuous in temperature and rate-limited per replan so a
    // replan never yanks the target speed down mid-braking.
    const want = o.util - (o.util - o.hotUtil) * clamp((hottest - o.hotCore) / o.hotSpan, 0, 1);
    this.util = this.util + clamp(want - this.util, -0.005, 0.005);
    const fuelMass = this.spec.mass + car.fuel * 0.75;
    this.grip *= Math.sqrt(this.env.mass / fuelMass); // lighter car → a bit more accel
    this.profile.solve(this.plan.k, this.plan.seg, this.env, { grip: this.grip, util: this.util, latUtil: 1, cap: o.learn ? this.learnCap() : null });
    this.replanAt = time + o.replanEvery;
  }

  /** Adaptive slip map. The offline envelope cannot see transient load transfer
   *  (fast direction changes, kerb strikes): where the car actually slid, the
   *  speed ceiling (fraction of the base profile) for the stretch leading into it is cut; it creeps back
   *  each calm pass so the limit is re-probed. Takes effect at the next replan. */
  learnSlip(s, absBeta, dt) {
    const o = this.options, plan = this.plan, n = plan.n, i = Math.floor(plan.index(s)) % n;
    if (absBeta > o.learnBeta) {
      const cut = o.learnRate * (absBeta - o.learnBeta) * dt;
      const back = Math.round(o.learnBack / plan.ds), ahead = Math.round(o.learnAhead / plan.ds);
      for (let d = -back; d <= ahead; d++) {
        const j = (i + d + n) % n, w = d <= 0 ? 1 + d / (back + 1) * 0.5 : 1 - d / (ahead + 1);
        this.trim[j] = Math.max(o.learnFloor, this.trim[j] - cut * w);
      }
      if (this.slideAt < 0) this.slideAt = s;
    } else if (i !== this.lastNode && absBeta < o.learnBeta * 0.5) {
      this.slideAt = -1;
      this.trim[i] = Math.min(1, this.trim[i] + o.learnGive);
    }
    this.lastNode = i;
  }

  /** A slide that escalated (recovery or a big slip angle) cuts the stretch into
   *  where it started at once: the rate-based map took ~3 laps of spins to learn it. */
  learnHit(s) {
    const o = this.options, plan = this.plan, n = plan.n;
    const i = Math.floor(plan.index(this.slideAt >= 0 ? this.slideAt : s)) % n;
    const back = Math.round(o.learnBack / plan.ds), ahead = Math.round((o.learnAhead + 40) / plan.ds);
    for (let d = -back; d <= ahead; d++) {
      const j = (i + d + n) % n, w = d <= 0 ? 1 + d / (back + 1) * 0.5 : 1;
      this.trim[j] = Math.max(o.learnFloor, this.trim[j] - o.learnHitCut * w);
    }
    this.replanAt = -1;
  }

  learnCap() {
    const base = this.plan.baseProfile.v, cap = this.capBuf ??= new Float64Array(this.plan.n);
    for (let i = 0; i < cap.length; i++) cap[i] = this.trim[i] < 1 ? base[i] * this.trim[i] : Infinity;
    return cap;
  }

  /** Highest speed now from which every point of the offset reference within the
   *  braking horizon can still be taken (Menger curvature of world points, lateral
   *  limit from the envelope, trimmed for lost downforce in a wake). */
  offsetPathSpeed(s, speed, qLim, wake) {
    const o = this.options, plan = this.plan, track = this.track;
    const pt = (x) => { const q = clamp(plan.sample(plan.q, x) + this.offset, -qLim, qLim); return track.at(x, q); };
    const range = Math.max(60, speed * speed / (2 * o.offBrake) + 20);
    let best = Infinity;
    let a = pt(s - 6), b = pt(s);
    for (let d = 6; d <= range; d += 6) {
      const c = pt(s + d);
      const abx = b.x - a.x, abz = b.z - a.z, bcx = c.x - b.x, bcz = c.z - b.z, acx = c.x - a.x, acz = c.z - a.z;
      const cross = Math.abs(abx * bcz - abz * bcx);
      const k = 2 * cross / Math.max(1e-6, Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(acx, acz));
      // Line curvature here: only bind where the offset path is the tighter one.
      const kLine = Math.abs(plan.sample(plan.k, s + d - 6));
      if (k > 0.002 && k > kLine * 1.02) {
        let v = speed;
        for (let it = 0; it < 2; it++) v = Math.sqrt(this.env.lat(v, this.grip) * this.util * o.offUtil * (1 - 0.12 * wake) / k);
        best = Math.min(best, Math.sqrt(v * v + 2 * o.offBrake * (d - 6)));
      }
      a = b; b = c;
    }
    return best;
  }

  update(car, cars, dt, context = {}) {
    const o = this.options, plan = this.plan, spec = this.spec;
    const time = context.time ?? 0;
    if (time >= this.replanAt || this.replanAt < 0) this.replan(car, time);

    const proj = context.projections?.get(car.id) ?? this.track.nearest(car.x, car.z);
    const speed = Math.max(0.5, car.speed);
    const course = speed > 2 ? Math.atan2(car.vx, car.vz) : car.yaw;
    // Predict the pose `tau` ahead to cover the steering actuator lag.
    const sP = proj.s + speed * o.tau * Math.cos(course - proj.heading);
    const latP = proj.lateral + speed * o.tau * Math.sin(course - proj.heading);

    // Traffic layer: offset from the racing line and a speed cap.
    let vCap = Infinity, offTarget = 0;
    if (this.traffic) ({ vCap, offset: offTarget } = this.traffic.update(car, cars, proj, context, dt));
    // Already sliding or running wide: no new lateral move until the car is settled.
    if (Math.abs(this.dbg.e ?? 0) > o.settleE || Math.abs(this.dbg.beta ?? 0) > o.settleBeta) offTarget = this.offset;
    const prev = this.offset;
    const maxRate = 2.2; // m/s lateral drift of the reference: no swerves
    this.offset += clamp(offTarget - this.offset, -maxRate * dt, maxRate * dt);
    this.offsetRate = (this.offset - prev) / dt;
    const qLim = Math.max(o.qMax + 0.2, this.traffic?.o.passMax ?? 0);
    const qt = clamp(plan.sample(plan.q, sP) + this.offset, -qLim, qLim);

    const e = latP - qt;
    const pathHeading = plan.sampleAngle(plan.heading, sP) + Math.atan2(this.offsetRate, speed);
    const ec = angle(course + car.yawRate * o.tau - pathHeading);
    const kappa = plan.sample(plan.k, proj.s + speed * o.ffLead);
    const L = spec.wheelbase;
    // Cascade: lateral PD on the (lag-predicted) Frenet error -> desired yaw rate
    // -> steering from kinematic feed-forward + yaw-rate feedback. The inner loop
    // is what keeps this rear-biased (oversteering) plant stable.
    const eDot = speed * Math.sin(ec);
    const aLat = speed * speed * kappa - o.kpE * e - o.kdE * eDot;
    // Authority: what the envelope says the tyres can give at this speed, plus headroom.
    const aMax = Math.max(9.81 * 1.4, this.env.lat(speed, this.grip) * o.latHead);
    const rDes = clamp(aLat, -aMax, aMax) / speed;
    const kEff = rDes / speed;
    let delta = Math.atan(L * kEff) + o.kUs * speed * speed * kEff + o.kr * (rDes - car.yawRate);
    // Body slip angle (velocity relative to nose): countersteer only into a real slide.
    const beta = speed > 3 ? angle(course - car.yaw) : 0;
    delta += o.kb * Math.sign(beta) * Math.max(0, Math.abs(beta) - o.betaDead);
    // Recovery: off the road or badly misaligned. Pure pursuit to a point on the
    // road ahead at low speed; the Frenet tracker is not valid there.
    const recovering = Math.abs(proj.lateral) > o.recLat || Math.abs(angle(course - proj.heading)) > o.recEc;
    if (recovering) {
      const Ld = Math.max(12, speed * 1.2);
      const tp = this.track.at(proj.s + Ld);
      const lt = clamp(plan.sample(plan.q, proj.s + Ld), -4, 4);
      const tx = tp.x + tp.nx * lt, tz = tp.z + tp.nz * lt;
      const alpha = angle(Math.atan2(tx - car.x, tz - car.z) - car.yaw);
      const d = Math.hypot(tx - car.x, tz - car.z);
      if (speed < 15) delta = 1.6 * alpha;
      else {
        // At speed, pursue along the velocity (not the nose) with yaw damping and
        // countersteer: nose-based pursuit steered straight ahead mid-slide and spun.
        const aC = angle(Math.atan2(tx - car.x, tz - car.z) - course);
        const rR = 2 * speed * Math.sin(aC) / d;
        delta = beta + Math.atan(L * rR / speed) + o.kr * (rR - car.yawRate);
      }
    }
    const steer = clamp(delta / spec.steeringLock, -1, 1);
    if (o.learn && !recovering && speed > 20) this.learnSlip(proj.s, Math.abs(beta), dt);
    const hit = speed > 20 && (recovering || Math.abs(beta) > o.learnHitBeta);
    if (o.learn && hit && !this.hitOn) this.learnHit(proj.s);
    this.hitOn = hit;

    // Longitudinal: profile feed-forward + speed feedback.
    const sL = proj.s + speed * o.vLead;
    let vt = plan.sample(this.profile.v, sL);
    let aff = plan.sample(this.profile.a, sL);
    // Off the planned line the corners are tighter than profiled: give a little away.
    vt *= 1 - o.offSlow * Math.abs(this.offset);
    // Offset path check: the reference actually driven (line + offset, clamped to
    // the road) can be far tighter than the line, e.g. pinned to the outside edge
    // mid-corner while side by side. Brake for its real curvature ahead.
    // Wake memory (decays over ~1 s): following a car, the downforce loss persists
    // into the corner even when the instantaneous wake flickers.
    const wake = this.wakeF = Math.max(car.aero?.wake ?? 0, (this.wakeF ?? 0) - dt);
    if (wake > 0.05 && Math.abs(kappa) > 0.003) vt *= 1 - o.wakeSlow * wake;
    if (Math.abs(this.offset) > 0.3 || wake > 0.2) {
      const vOff = this.offsetPathSpeed(proj.s, speed, qLim, wake);
      if (vOff < vt) { vt = vOff; aff = Math.min(aff, 0); }
    }
    if (vCap < vt) { vt = vCap; aff = Math.min(aff, 0); }
    // Off the line (recovery): slow down proportionally to lateral error.
    // Shed speed gently: a panic stop while sliding is what turns a moment off line into a spin.
    if (recovering) vt = Math.min(vt, Math.max(o.recSpeed, speed - 2));
    const aCmd = aff + o.kv * (vt - car.speed);
    const need = aCmd + this.env.drag(car.speed) + 0.13;
    const engineAcc = this.env.engineForce(car.speed) / this.env.mass;
    let throttle = 0, brake = 0;
    if (need >= 0) throttle = clamp(need / Math.max(1, engineAcc), 0, 1);
    else brake = clamp(-need * o.brakeGain, 0, 1);
    // Drive governor: the host TC only acts late; cut drive before the rear lets go.
    const rearSlip = Math.max(car.wheels[2].tyre.kappa, car.wheels[3].tyre.kappa);
    const gov = clamp(Math.min(1 - (Math.abs(beta) - o.betaCut) * o.betaGain, 1 - (rearSlip - o.slipCut) * o.slipGain), 0.15, 1);
    if (speed > 8) throttle = Math.min(throttle, gov);
    // Brake governor: a growing slip angle under braking is the rear going light; ease off.
    if (speed > 8) brake *= clamp(1 - (Math.abs(beta) - o.betaCut) * o.brakeBetaGain, 0.25, 1);

    car.controls = { throttle, brake, steer };
    this.dbg = { vt, e, ec, kappa, grip: this.grip, util: this.util, off: this.offset, vCap, beta, gov, rec: recovering };
  }
}
