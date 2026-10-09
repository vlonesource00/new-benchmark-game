import { clamp, angle } from '../../apex/src/math.js';
import { HALF_LEN } from './perception.js';

const comb = (t) => Math.hypot(t.kappa * 10.5, Math.tan(Math.min(1.2, Math.abs(t.alpha))) * 8.6);
const latSlip = (t) => Math.tan(Math.min(1.2, Math.abs(t.alpha))) * 8.6;

/**
 * Executes the committed lane. Lateral: curvature preview + heading/offset correction bounded by the grip left,
 * mapped through the identified steering and sideslip maps, yaw-rate and slide feedback, bounded lateral jerk.
 * Longitudinal: the lane's speed profile (or braking envelope when tow/hybrid makes thrust worth more), the plan's
 * following cap, an immediate nose cap, friction-circle sharing, a traction governor and a protective slip layer.
 * Stability is anticipated: the yaw overshoot's trend over the next 0.15 s eases the pedals before the slide.
 */
export class Controller {
  constructor(driver) { this.driver = driver; this.reset(); }
  reset() { this.steer = 0; this.kcF = NaN; this.tcCap = 1; this.stability = 1; this.lastOver = 0; this.recovers = 0; this.lastStab = 1; this.guard = false; }
  /** Side guard: the car alongside we must not drift toward, and the drift rate the room allows. */
  neighbor(me, field, v) {
    let best = null;
    for (const r of field.list) {
      const Ls = HALF_LEN + r.halfLength;
      // alongside, or about to be: a car ahead we are closing on, a car behind that is closing on us. A car following
      // in our wheel tracks is not alongside, and steering away from it walks us off the road.
      const reach = r.ds >= 0 ? Ls + 1.5 + Math.max(0, me.v - r.v) * 0.4 : Ls + 0.5 + Math.max(0, r.v - me.v) * 0.4;
      if (Math.abs(r.ds) > reach) continue;
      const dir = Math.sign(r.d - me.d) || 1, gap = Math.abs(r.d - me.d) - (me.halfWidth + r.across);
      // the room may be used up over 0.8 s, plus whatever the other car is doing away from us; never further away than
      // the road allows: at the edge we hold our ground
      const edge = this.driver.track.halfWidth - me.halfWidth - 0.3 + dir * me.d;
      let rate = Math.max(0, gap - 0.3) / 0.8 + dir * r.vl;
      if (edge < 1.5) rate = Math.max(rate, -Math.max(0, edge) / 0.8);
      if (!best || rate < best.rate) best = { dir, gap, rate, id: r.id };
    }
    return best;
  }
  step(real, car, path, c, dt, ctx) {
    const d = this.driver, o = d.options, model = d.model, line = d.line, v = Math.max(0.5, car.speed);
    const { i, f, e } = c;
    // ---- lateral ----
    const hPath = path.heading(i, f), beta = Math.atan2(car.v, Math.max(2, car.u)), psi = angle(car.yaw + beta - hPath);
    const Lp = clamp(0.32 * v + 7, 9, 32);
    const kp = path.sample(path.ks, i, f, v * (o.preview ?? 0.08));
    const fbMax = (o.fbShare ?? 0.45) * model.lat(v) / (v * v);
    let corr = clamp(-2 * psi / Lp - e / (Lp * Lp), -fbMax, fbMax);
    const nb = ctx.nb; this.guard = false;
    if (nb) {
      const sl = (path.sample(path.lat, path.idx(i + 2), f, 0) - path.sample(path.lat, path.idx(i - 2), f, 0)) / (4 * path.ds);
      const allowed = nb.rate - nb.dir * v * clamp(sl, -0.6, 0.6), drift = nb.dir * v * Math.sin(psi);
      if (drift > allowed) {
        const pt = nb.dir * Math.asin(clamp(allowed / v, -0.5, 0.5)), fbSafe = 0.8 * model.lat(v) / (v * v);
        corr = clamp(-2 * (psi - pt) / Lp, -fbSafe, fbSafe); this.guard = true;
      }
    }
    let kc = kp + corr; const J = o.steerJerk ?? 65;
    if (J && Number.isFinite(this.kcF) && dt > 0) { const dk = J * dt / (v * v); kc = this.kcF + clamp(kc - this.kcF, -dk, dk); }
    this.kcF = kc;
    this.ayReq = v * v * kp;
    const ayM = Math.sign(kc) * Math.min(Math.abs(v * v * kc), (o.ayMapCap ?? 0.98) * model.lat(v) / Math.max(0.5, model.margin ?? 1));
    const ff = model.steerFor(ayM, v), rDes = ayM / Math.max(2, v), rErr = rDes - car.yawRate;
    const dBeta = beta - model.betaFor(ayM, v), slide = Math.sign(dBeta) * Math.max(0, Math.abs(dBeta) - (o.slideBand ?? 0.02));
    this.steer = clamp(ff + (o.yawGain ?? 0.45) * rErr + (o.slideGain ?? 5) * slide, -1, 1);
    // ---- stability, anticipated ----
    const rK = car.ay / v, rRef = Math.sign(rK) === Math.sign(car.yawRate) && Math.abs(rK) > Math.abs(rDes) ? rK : rDes;
    const over = Math.sign(car.yawRate) === Math.sign(rRef) ? Math.max(0, Math.abs(car.yawRate) - Math.abs(rRef)) : Math.abs(car.yawRate);
    const trend = dt > 0 ? clamp((over - this.lastOver) / dt, 0, 4) : 0; this.lastOver = over;
    const overP = over + trend * (o.anticipate ?? 0);
    const dBetaS = Math.min(Math.abs(dBeta), Math.abs(beta - model.betaFor(car.ay, v)));
    const straight = v > 50 && Math.abs(this.ayReq) < 4, wobble = straight ? Math.max(0.4, clamp((Math.abs(beta) - 0.015) / 0.035, 0, 1)) : 1;
    this.stability = clamp(1 - 2.5 * Math.max(0, overP - 0.08) * wobble - 4 * Math.max(0, dBetaS - (o.betaLimit ?? 0.06)), 0, 1);
    if (this.stability < 0.3 && !(this.lastStab < 0.3)) this.recovers++;
    this.lastStab = this.stability;
    // ---- longitudinal ----
    const look = v * 0.1, d2 = Math.max(4, v * 0.25), wk = car.aero?.wake ?? 0;
    const prof = ctx.freeThrust || wk > 0.05 ? path.vbrk : path.v;
    let vt = path.sample(prof, i, f, look), vt2 = path.sample(prof, i, f, look + d2);
    // why the demand is what it is (trace only, nothing reads it back): the profile it came from, every constraint that
    // lowered the target speed (m/s taken) and every layer that cut the pedal (pedal taken); cap/cut name the largest
    const why = { src: (path === d.line ? 'line' : 'lane') + (prof === path.vbrk ? '-envelope' : ''), caps: {}, cuts: {}, cap: 'none', cut: 'none' };
    const lower = (name, x) => { if (x < vt) { if (x < vt - 0.05) why.caps[name] = vt - x; vt = x; } };
    if (wk > 0.05) {
      const ws = model.wakeSpeed(v, wk), lim = (j) => path.vmax[path.idx(i + j)] < path.v[path.idx(i + j)] + 2;
      if (lim(1) || lim(Math.round(look / path.ds) + 2)) { lower('wake', vt * ws); vt2 *= ws; }
    }
    lower('plan-cap', ctx.cap ?? Infinity); lower('nose', ctx.nose ?? Infinity); lower('pit', ctx.pitCap ?? Infinity);
    vt2 = Math.min(vt2, ctx.cap2 ?? Infinity, ctx.nose ?? Infinity, ctx.pitCap2 ?? Infinity);
    for (const [k, x] of Object.entries(why.caps)) if (x > 0.5 && x > (why.caps[why.cap] ?? 0)) why.cap = k;
    const aProf = (vt2 * vt2 - vt * vt) / (2 * d2);
    this.targetSpeed = vt;
    let throttle = 0, brake = 0; const err = vt - v;
    if (err > 0.4 || (err > -0.2 && aProf > -1)) throttle = clamp(0.4 + err * 0.9 + aProf * 0.1, 0, 1);
    else if (-err < 2 && -aProf < 3) throttle = 0;
    else { brake = clamp(Math.max(0, -aProf) / model.brake(v) + (v - vt) * 0.18, 0, 1); if (v < vt - 0.5) brake *= 0.3; }
    const cut = (name, t) => { const x = throttle - t; if (x > 0.005) { why.cuts[name] = x; if (x > 0.02 && x > (why.cuts[why.cut] ?? 0)) why.cut = name; } return t; };
    this.raw = { throttle, brake };
    if (ctx.noseBrake > 0) { cut('nose-brake', 0); throttle = 0; brake = Math.max(brake, ctx.noseBrake); }
    const phys = model.lat(v) / Math.max(0.5, (model.margin ?? 1) * (line.trim[i] ?? 1));
    const use = clamp(Math.max(Math.abs(v * v * kp), Math.abs(car.ay) * 0.9) / Math.max(1, phys), 0, 1);
    const share = Math.sqrt(Math.max(0, 1 - use * use)); this.share = share;
    if (brake > 0) brake = Math.min(brake, Math.max(o.brakeFloor ?? 0.12, share * (o.brakeAllow ?? 1.15)));
    throttle = cut('grip-share', Math.min(throttle, Math.max(o.throttleFloor ?? 0.2, share * (o.throttleAllow ?? 2.4))));
    // traction governor on the driven axle, tightened by heat and age
    const di = car.spec.drive === 'front' ? 0 : 2, rs = Math.max(comb(car.wheels[di].tyre), comb(car.wheels[di + 1].tyre));
    const S = ctx.tractionSlip ?? o.tractionSlip ?? 2.05;
    this.tcCap = clamp(this.tcCap + dt * (rs > S ? -10 * (rs - S) - 1 : 2.5), 0.1, 1);
    // what the governor saw on the worse driven wheel: wheelspin and lateral slip, the two parts of its combined slip
    const tw = comb(car.wheels[di].tyre) >= comb(car.wheels[di + 1].tyre) ? car.wheels[di].tyre : car.wheels[di + 1].tyre;
    why.slip = { comb: rs, spin: Math.abs(tw.kappa) * 10.5, lat: latSlip(tw), limit: S };
    throttle = cut('traction', Math.min(throttle, this.tcCap));
    const sF = Math.max(latSlip(car.wheels[0].tyre), latSlip(car.wheels[1].tyre)), sR = Math.max(latSlip(car.wheels[2].tyre), latSlip(car.wheels[3].tyre));
    const hi = o.slipHi ?? 2.15, tooFar = Math.max(0, Math.max(sF, sR) - hi), loose = Math.max(0, sR - sF - (o.looseBand ?? 0.35));
    const protect = clamp((1 - (o.protectGain ?? 2) * tooFar) * (1 - (o.looseGain ?? 1.2) * loose), 0.15, 1);
    throttle = cut('slip', throttle * protect); if (sR > hi) brake *= protect;
    brake *= this.stability; throttle = cut('stability', throttle * this.stability);
    this.why = why;
    this.mode = brake > 0 ? 'BRAKE' : throttle > 0.95 || (Math.abs(this.ayReq) < 4 && throttle > 0.5) ? 'PUSH' : 'CORNER';
    real.controls = this.sent = { throttle, brake, steer: this.steer };
  }
}
