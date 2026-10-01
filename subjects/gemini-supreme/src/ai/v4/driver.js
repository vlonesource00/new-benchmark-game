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
  ds: 2, qMax: 6.5, lineBudgetMs: 2500, envelope: null,
  // tracker
  tau: 0.085, ffLead: 0.10, kUs: 0.0, kpE: 1.4, kdE: 2.2, kr: 1.0, kb: 0, betaDead: 0.13, latHead: 1.15,
  vLead: 0.08, kv: 6, brakeGain: 1 / 27,
  // throttle governor: slip angle / rear slip ratio above which drive is cut
  betaCut: 0.12, betaGain: 7, brakeBetaGain: 5, slipCut: 0.09, slipGain: 6,
  // tyre model
  gripTrim: 1.0, replanEvery: 0.5, util: 1.0, hotUtil: 0.94, hotCore: 100, hotSpan: 20,
  // recovery (off the road or pointing the wrong way)
  recLat: 8.8, recEc: 0.9, recSpeed: 14,
  // traffic
  // Off by default: holding the line was cleaner than any speed cap (DESIGN.md).
  traffic: false, offSlow: 0.012
});

export class GeminiV4Driver {
  constructor({ track, car, options = {} }) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    const o = this.options;
    this.track = track;
    this.spec = car.spec;
    this.plan = RacePlan.get(track, car.spec, { ds: o.ds, qMax: o.qMax, lineBudgetMs: o.lineBudgetMs, envelope: o.envelope });
    this.env = this.plan.envelope;
    this.profile = new SpeedProfile(this.plan.n);
    this.grip = 1; this.util = o.util;
    this.replanAt = -1;
    this.offset = 0; this.offsetRate = 0;
    this.traffic = o.traffic ? new TrafficLayer(this, o) : null;
    this.dbg = {};
  }

  replan(car, time) {
    const o = this.options;
    const f = car.wheels.reduce((a, w) => a + tyreThermalFactor(w.tyre), 0) / 4;
    const hottest = Math.max(...car.wheels.map((w) => w.tyre.core));
    this.grip = f * o.gripTrim;
    // Past the hot threshold, run progressively below the limit (slip power falls
    // faster than grip). Continuous in temperature and rate-limited per replan so a
    // replan never yanks the target speed down mid-braking.
    const want = o.util - (o.util - o.hotUtil) * clamp((hottest - o.hotCore) / o.hotSpan, 0, 1);
    this.util = this.util + clamp(want - this.util, -0.005, 0.005);
    const fuelMass = this.spec.mass + car.fuel * 0.75;
    this.grip *= Math.sqrt(this.env.mass / fuelMass); // lighter car → a bit more accel
    this.profile.solve(this.plan.k, this.plan.seg, this.env, { grip: this.grip, util: this.util, latUtil: 1 });
    this.replanAt = time + o.replanEvery;
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
      delta = speed < 15 ? 1.6 * alpha : Math.atan2(2 * L * Math.sin(alpha), d);
    }
    const steer = clamp(delta / spec.steeringLock, -1, 1);

    // Longitudinal: profile feed-forward + speed feedback.
    const sL = proj.s + speed * o.vLead;
    let vt = plan.sample(this.profile.v, sL);
    let aff = plan.sample(this.profile.a, sL);
    // Off the planned line the corners are tighter than profiled: give a little away.
    vt *= 1 - o.offSlow * Math.abs(this.offset);
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
