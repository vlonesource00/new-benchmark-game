// ORACLE driver: follows its own line at the speed profile, with combat layered on as a lateral lane and a
// speed cap. Runs on the main thread at physics rate, so every decision uses the current pose of every car.
import { clamp, angle, wrap } from '../../../game/engine/sim/math.js';
import { tyreGrip } from '../../../game/engine/sim/tyre.js';
import { envelope, at, steadySteer } from './envelope.js';
import { Line } from './line.js';
import { lineData } from './store.js';
import { Combat, downforceShare } from './combat.js';
import { cloneCar, cloneDriver, shadowTrack } from './shadow.js';

export class OracleDriver {
  constructor(track, options = {}) { this.track = track; this.options = options; this.classId = null; this.hint = -1; this.steer = 0; this.mode = 'INIT'; }
  prepare(car) {
    if (this.classId === car.classId) return;
    this.classId = car.classId; this.spec = car.spec;
    this.env = envelope(car.classId);
    this.line = this.options.line ?? new Line(this.track, car.spec, this.env, this.options.optimise ? null : this.options.lineData?.[`${this.track.id}:${car.classId}`] ?? lineData(this.track.id, car.classId), this.options);
    if (this.options.optimise && !this.options.line) this.options.multistart === false ? this.line.optimise(this.options.optimise) : this.line.solve(this.options.optimise);
    this.combat = new Combat(this.line, this.options);
    this.reset();
  }
  reset() { this.hint = -1; this.steer = 0; this.lateral = 0; this.combat?.reset(); this.trace = null; this.osPrev = undefined; this.osRate = 0; this.ie = 0; this.kc = NaN; this.bRef = NaN; this.laneV = 0; this.gp = 1; this.tick = 0; this.veto = null; this.lastCmd = null; }

  /**
   * Live grip against the pad's reference tyre: compound, wear and pressure read exactly. Temperature is counted
   * only in part (o.tempWeight): a driver who backs off for a cold tyre cools it further, a loop that ends seconds
   * off the pace, while driving at the limit brings the tread back to its window.
   */
  gripFactor(car) {
    // Force-weighted: the loaded (outside, hot) tyres do the cornering, so the ratio is of summed forces, not an average.
    let live = 0, ref = 0;
    const tw = this.options.tempWeight ?? 1;
    for (const w of car.wheels) {
      const load = Math.max(800, w.load || car.spec.mass * 2.45), t = w.tyre, opt = t.optimum ?? 85;
      live += tyreGrip({ ...t, core: opt + (t.core - opt) * Math.sqrt(tw) }, load) * load;
      ref += tyreGrip({ ...t, core: 92, optimum: 90, pressure: 2.15, wear: 0, gripScale: 1 }, load) * load;
    }
    return live / ref;
  }

  update(car, cars, dt, context = {}) {
    this.prepare(car);
    const line = this.line, o = this.options, v = car.speed, state = context.state ?? {};
    const loc = line.locate(car.x, car.z, this.hint); this.hint = loc.i; this.loc = loc;
    // Someone else had the wheel (the formation autopilot until green): the controller's own state is resynced to the
    // car as it is (its offset from the line becomes the lane, the pedals and the curvature are the car's), so the
    // handover is not a snap back to the racing line from a two-wide slot.
    if (o.poseInit && !this.isShadow && car.controls && (this.lastCmd == null || Math.abs(car.controls.steer - this.lastCmd) > 1e-6)) {
      this.resyncs = (this.resyncs ?? 0) + 1; this.lateral = clamp(loc.e, -(o.maxLane ?? 7), o.maxLane ?? 7); this.laneV = 0; this.kc = NaN; this.bRef = NaN;
      this.thr = car.controls.throttle ?? 0; this.brk = car.controls.brake ?? 0; if (this.combat) this.combat.lane = this.lateral;
    }
    // Speed scale for this moment: live tyre grip (sqrt: corner speed goes with the root of grip) and the road's water.
    const surface = this.track.surface(car.x, car.z), wet = surface.wet ?? 0;
    if ((o.guard ?? true) && !this.isShadow && v > 10 && (++this.tick + (Number(car.id) || 0) * 5) % (o.guardEvery ?? 12) === 0) this.govern(car);
    // In a rival's wake the car has up to 16% less downforce (the physics' own figure): the plan slows by what that
    // costs the grip at this speed, smoothed so a wake that comes and goes does not pulse the pedals.
    // Wake: the downforce it costs is felt at once (a slow estimate lets the car into a corner on grip it no longer
    // has), and given back gradually as the car leaves the tow.
    const wk = car.aero?.wake ?? 0;
    this.wakeSm = o.wakeRise && wk > (this.wakeSm ?? 0) ? wk : (this.wakeSm ?? 0) + (wk - (this.wakeSm ?? 0)) * Math.min(1, dt * 4);
    const wakeLoss = o.wakeGrip === false ? 1 : 1 - 0.16 * (o.wakeK ?? 1) * this.wakeSm * downforceShare(this.env, v);
    const grip = Math.sqrt(clamp(this.gripFactor(car), 0.6, 1.15) * (1 - 0.36 * wet * 1.05) * wakeLoss) * (o.pace ?? 1) * (this.gp ?? 1);
    // Combat: the lane to drive (metres right of the line) and any speed cap behind traffic.
    const fight = o.forceLane != null ? { lateral: o.forceLane, cap: Infinity, mode: 'TEST' } : context.mode === 'race' || context.mode === undefined ? this.combat.update(car, cars, loc, v, dt, { ...context, grip, braking: (this.brk ?? 0) > 0.1 }) : { lateral: 0, cap: Infinity };
    this.mode = fight.mode ?? 'PACE'; this.laneHold = fight.lateral;
    if (this.veto != null && !this.isShadow) fight.lateral = this.veto;

    // Pedals: aim at the profile a short distance ahead, so the braking point is met rather than chased.
    const look = Math.max(3, v * (o.speedLook ?? 0.22));
    // Off the line the turn is tighter or wider by the lane offset (k > 0 turns left, offsets are + right): corner speed goes with the root of the radius.
    // A lane off the line is also held to the cornering limit of its own path (a clamped offset bends where the line does not).
    const lane = Math.abs(this.lateral) > 0.3 ? this.lateral : 0;
    const lp = lane ? 1 - (o.lanePace ?? 0) * Math.min(1, Math.abs(lane) / 2) : 1;
    // The lane's share of the line speed is smooth over its 24 m chord: taken every 8 m and interpolated.
    const lf = [], laneAt = (d) => { const q = Math.max(0, d) / 8, a = Math.floor(q), t = q - a; lf[a] ??= line.laneFactor(loc.i, loc.f, a * 8, lane); lf[a + 1] ??= line.laneFactor(loc.i, loc.f, a * 8 + 8, lane); return lf[a] + (lf[a + 1] - lf[a]) * t; };
    const target = o.forwardPass ? line.v : line.vb, speedAt = (d) => { const p = line.sample(target, loc.i, loc.f, d) * grip * lp; return lane ? p * laneAt(d) : p; };
    // capT: a follow cap is a safe speed for the gap now, met over a time headway (a cap 3 m/s under the car at 75 m/s
    // is a lift, not a stab of full brake); the profile itself is met at the look distance as before.
    const capD = Math.max(look, v * (o.capT ?? 0)), vNow = speedAt(0), vAhead = capD > look ? speedAt(look) : Math.min(speedAt(look), fight.cap);
    let want = (vAhead * vAhead - v * v) / (2 * look);
    if (capD > look && fight.cap < Infinity) want = Math.min(want, (fight.cap * fight.cap - v * v) / (2 * capD));
    // Braking: the hardest deceleration any point of the profile ahead asks for. It takes over only once it nears
    // what the tyres can give, so the car keeps driving to the near target until its braking point arrives.
    const lead = v * (o.brakeLead ?? 0), reach = Math.min(400, v * v / (2 * Math.max(6, at(this.env.brake, v) * 0.7)) + 12);
    let need = 0;
    for (let d = 4; d < reach; d += 2.5) {
      const vp = d < capD && capD > look ? speedAt(d) : Math.min(speedAt(d), fight.cap), dd = Math.max(1, d - lead);
      need = Math.min(need, (vp * vp - v * v) / (2 * dd));
    }
    const drag = 0.5 * 1.225 * car.spec.area * car.spec.cd * v * v / (car.spec.mass + car.fuel * 0.75);
    let throttle = 0, brake = 0;
    // Share of the tyre the corner is using here: braking and drive get only what the ellipse leaves.
    // laneCurv: on a lane off the line the car turns on that lane's radius (R + y on the outside of the turn), not the line's.
    // kWin: the corner share is read off the curvature averaged over this many seconds ahead, not one station (a
    // station-to-station wobble in k swung the share, and the brake takeover with it, between frames).
    const kw = o.kWin ?? 0.4, ks = kw ? [0.1, 0.3, 0.5, 0.7, 0.9].reduce((a, u) => a + line.sample(line.k, loc.i, loc.f, v * kw * u), 0) / 5 : line.sample(line.k, loc.i, loc.f, v * 0.1), k = o.laneCurv ? Math.abs(ks / Math.max(0.5, 1 + ks * this.lateral)) : Math.abs(ks), latCap = at(this.env.lat, v) * line.latScale * line.sample(line.grip, loc.i, loc.f) * grip * grip;
    const used = clamp(v * v * k / Math.max(1, latCap), 0, 1), cp = o.combExp ?? 2, rest = Math.max(o.restFloor ?? Math.sqrt(0.12), (1 - used ** cp) ** (1 / cp));
    const avail = at(this.env.brake, v) * line.brakeGain * grip * grip * rest;
    // needHys: a braking point once taken is held until the need falls this share of the grip below the trigger.
    this.taking = need < -((o.brakeOn ?? 0.7) - (this.taking ? o.needHys ?? 0 : 0)) * avail;
    if (this.taking) want = Math.min(want, need);
    // brakeHys: once on the brakes the car stays on them until the plan really asks for drive again, so a want hovering
    // at the threshold does not swap pedals every frame.
    const hys = o.brakeHys ?? 0, onBrake = (this.brk ?? 0) > 0.02;
    if (want < -0.4 + (onBrake ? hys : 0) || v > vNow * 1.02 + 0.5 - (onBrake ? hys : 0)) {
      this.driving = false;
      brake = clamp((-want - drag) / Math.max(4, at(this.env.brake, v)) * (o.brakeGain ?? 1.3) + (v - vNow) * 0.05, 0, 1) * Math.min(1, rest * (o.trail ?? 1.15));
    } else {
      throttle = clamp((want + drag + 0.6) / (at(this.env.accel, v) + drag + 0.6) + Math.max(0, vNow - v) * (o.holdGain ?? 0), 0, 1);
      // Drive gets what the tyres have left now: the measured lateral load, not the line's curvature (a car a metre
      // wide of the line, or past the apex, has grip to spare that the plan does not know about).
      const restNow = o.measUse ? Math.sqrt(Math.max(0.12, 1 - clamp(Math.abs(car.ay) / Math.max(1, latCap), 0, 1) ** 2)) : rest;
      // thrBlend: drive rises from the speed hold to all the grip leaves over this much want (m/s²), instead of a step at
      // 0.4 (a want hovering there pumped the pedal between a quarter and full throttle).
      const full = Math.min(1, restNow * (o.restThr ?? 1.6));
      // thrHys: full drive comes on at a want of 0.4 and stays until the want falls this far below it, so a want
      // hovering at the threshold no longer pumps the pedal between the speed hold and full drive.
      const hy = o.thrHys ?? 0; this.driving = want > 0.4 || (this.driving && hy > 0 && want > 0.4 - hy);
      const tb = o.thrBlend ?? 0;
      if (tb) { if (full > throttle) throttle += (full - throttle) * clamp((want - 0.4) / tb, 0, 1); }
      else if (this.driving) throttle = Math.max(o.restMax ? throttle : 0, full);
    }

    // Steering: pure pursuit in the velocity frame, plus the body slip so the front wheels point where the car goes.
    // Lane changes spend the grip the corner leaves. An S of a few metres at racing speed asks more lateral force of
    // the tyres than the corner itself (3 m in a second at 45 m/s is over a g), so the lane moves with a lateral
    // acceleration held to the spare grip (what braking and the corner leave of the ellipse), at a rate it can still
    // stop from at the target.
    // laneV0: above this speed the lane moves no faster than laneV0/v of its rate (a metre a second across at 75 m/s is
    // as much as the chassis follows cleanly, and the planner forecasts the same rate).
    const laneRate = (fight.laneRate ?? o.laneRate ?? 3.2) * (o.laneV0 !== 0 ? Math.min(1, (o.laneV0 ?? 40) / Math.max(1, v)) : 1), dl = fight.lateral - this.lateral;
    if (o.laneGrip === 0) { this.laneV = 0; this.lateral += clamp(dl, -laneRate * dt, laneRate * dt); }
    else {
      // laneNeed: the braking the profile asks for ahead (need) is spent on the brakes soon, so a lane move is held to the grip
      // it will leave then, not just to what is spare now: a move still running at the braking point has nothing to stop with.
      const lat = latCap * (o.laneGrip ?? 0.95), ax = Math.min(Math.max(Math.abs(car.ax), o.laneNeed ? -need * o.laneNeed : 0), lat * 0.9);
      const spare = this.spare = Math.max(o.laneAccMin ?? 0.6, Math.sqrt(lat * lat - ax * ax) - v * v * k);
      const vWant = Math.sign(dl) * Math.min(laneRate, Math.sqrt(2 * spare * Math.abs(dl)));
      // Speeding the lane up spends spare grip; slowing it down is always allowed (the grip can vanish mid-move,
      // and a lane that sails past its target is the worse slide), and the lane never passes its target.
      const lv = this.laneV ?? 0, slowing = Math.abs(vWant) < Math.abs(lv) || Math.sign(vWant) !== Math.sign(lv), rate = slowing ? Math.max(spare, 6) : spare;
      this.laneV = lv + clamp(vWant - lv, -rate * dt, rate * dt);
      const step = this.laneV * dt;
      if (Math.sign(step) !== Math.sign(dl) || Math.abs(step) >= Math.abs(dl)) { this.lateral += Math.sign(step) === Math.sign(dl) ? dl : 0; if (Math.abs(step) >= Math.abs(dl)) this.laneV = 0; }
      else this.lateral += step;
    }
    const beta = Math.atan2(car.v, Math.max(2, car.u)), hv = v > 2 ? Math.atan2(car.vx, car.vz) : car.yaw;
    const err = loc.e - line.offset(loc.i, loc.f, 0, this.lateral);
    let delta;
    if (o.pursuit) {
      // The old follower (kept for comparison): pure pursuit in the velocity frame plus slip and yaw patches.
      const ld = clamp((o.previewBase ?? 4) + v * (o.preview ?? 0.3), 6, 34), p = line.point(loc.i, loc.f, ld, this.lateral);
      const dx = p.x - car.x, dz = p.z - car.z, lx = dx * Math.cos(hv) - dz * Math.sin(hv), kappa = 2 * lx / Math.max(9, dx * dx + dz * dz);
      delta = Math.atan(car.spec.wheelbase * kappa) + beta * (o.slipComp ?? 1.2) - (car.yawRate - v * kappa) * (o.yawDamp ?? 0.16);
      this.ie = clamp((this.ie ?? 0) + (Math.abs(beta) < 0.3 ? err * dt : 0) - (this.ie ?? 0) * dt * (o.ieLeak ?? 0.3), -(o.ieMax ?? 8), o.ieMax ?? 8);
      delta -= (o.ki ?? 0) * this.ie + (o.kp ?? 0) * err;
    } else delta = this.track_(car, line, loc, v, hv, err, dt, (grip / ((o.pace ?? 1) * (this.gp ?? 1))) ** 2);
    // Front slip limit: the front tyre's slip angle is the front axle's velocity direction minus the wheel angle.
    // Past the force peak more lock only scrubs speed (a countersteer that overshoots does the same), so the wheel
    // angle is held inside the band that keeps the front slip at or under the peak.
    if (o.frontAlpha && v > 8) {
      const a = car.spec.wheelbase * (1 - car.spec.frontWeight), bf = Math.atan2(car.v + car.yawRate * a, Math.max(2, car.u)), am = o.frontAlpha;
      delta = clamp(delta, bf - am, bf + am);
    }
    const cmd = clamp(delta / car.spec.steeringLock, -1, 1);
    this.steer = cmd;
    // Rear stability: when the tail steps out (slip outward of the turn the car is yawing into), the brake and
    // the throttle both let the rear tyres have their grip back before the slide grows.
    // Steady limit cornering runs 0.15–0.2 rad of slip in this physics; a slide is slip past that, or slip growing fast.
    // Oversteer: with the tracking steering, body slip past what the car runs steadily at this load (the pad's
    // reading), measured outward of the turn; with the old follower, the raw slip.
    const os = o.pursuit ? -beta * Math.sign(car.yawRate || 1e-9) : -(this.trace_?.slip ?? 0) * Math.sign(this.trace_?.ay || car.yawRate || 1e-9);
    this.osRate = (this.osRate ?? 0) + ((os - (this.osPrev ?? os)) / Math.max(dt, 1e-3) - (this.osRate ?? 0)) * Math.min(1, dt * 20); this.osPrev = os;
    const oversteer = os + Math.max(0, this.osRate) * (o.slideLead ?? 0.15), limit = o.slideBeta ?? (o.pursuit ? 0.24 : 0.05);
    this.catching = oversteer > limit && v > 8;
    if (this.catching) {
      // Catch: release the brake, and hold a breath of throttle so the rear is neither engine-braked nor driven.
      const k = clamp(1 - (oversteer - limit) * (o.catchGain ?? (o.pursuit ? 14 : 8)), 0, 1); brake *= k;
      throttle = clamp(throttle, o.catchThrottle ?? 0.08, 0.15 + 0.5 * k);
    } else if (brake < 0.02 && v > 15) throttle = Math.max(throttle, o.coastThrottle ?? 0);
    // Rear stability on entry: the rear slipping more than the front (a light inside rear locking under the brake,
    // or engine braking) is the start of a trail-braking spin. The brake gives the rear back its lateral force,
    // and a breath of throttle keeps the engine from braking the rear wheels.
    if (o.rearGuard && v > 12) {
      const sF = (Math.abs(car.wheels[0].tyre.alpha) + Math.abs(car.wheels[1].tyre.alpha)) / 2, sR = (Math.abs(car.wheels[2].tyre.alpha) + Math.abs(car.wheels[3].tyre.alpha)) / 2;
      const ex = sR - sF - (o.rearGuard ?? 0.04);
      if (ex > 0) { brake *= clamp(1 - ex * (o.rearGain ?? 12), 0.2, 1); if (throttle < 0.03) throttle = o.neutralThrottle ?? 0.03; }
    }
    const slide = oversteer;
    // Pedals move at a driver's rate, not bang-bang between frames.
    const down = brake > 0 || this.catching ? 8 : o.liftRate ?? 8;
    this.thr = (this.thr ?? 0) + clamp(throttle - (this.thr ?? 0), -dt * down, dt * 6); this.brk = (this.brk ?? 0) + clamp(brake - (this.brk ?? 0), -dt * 10, dt * 14);
    if (brake > 0) this.thr = Math.min(this.thr, throttle); if (throttle > 0) this.brk = Math.min(this.brk, brake);
    // Rear brake circle: the 0.58 bias over-brakes a rear the weight transfer has unloaded, and a locking rear has no
    // lateral force left (the start of a trail-braking spin). The brake is held so the rear's slip ratio stays inside
    // what its slip angle leaves of the force peak, the braking twin of the traction cap below.
    const bs = o.brakeSlip ?? 0;
    if (bs && v > 8 && this.brk > 0.02) {
      const a = car.wheels[2].tyre, b = car.wheels[3].tyre;
      const sx = Math.max(-a.kappa, -b.kappa) * 10.5, sy = Math.max(Math.abs(Math.tan(a.alpha)), Math.abs(Math.tan(b.alpha))) * 8.6;
      const sxMax = Math.max(o.brakeSlipFloor ?? 0.25, Math.sqrt(Math.max(0, bs * bs - sy * sy)));
      if (sx > sxMax) this.brk *= clamp(1 - (sx - sxMax) * (o.brakeSlipGain ?? 1.5), 0.3, 1);
      this.bsCut = sx > sxMax;
    } else this.bsCut = false;
    // Traction: wheelspin steals the driven tyres' force from the lateral direction (the force is shared in proportion
    // to the slip components), so the slip ratio is capped by what the slip angle already uses: a friction circle on
    // the slip itself. Persisting the cut lets the pedal rate limit bring the throttle back in smoothly.
    if ((o.tc ?? !o.pursuit) && v > 8) {
      const d0 = car.spec.drive === 'front' ? 0 : 2, a = car.wheels[d0].tyre, b = car.wheels[d0 + 1].tyre;
      // tcAvg: blend toward the pair's mean slip (an inside wheel spinning past the peak loses little, the force curve is
      // flat there, and cutting for it costs the loaded wheel its drive). tcRate: the cut is a rate per second, not per frame.
      const avg = o.tcAvg ?? 1, sx = (Math.max(a.kappa, b.kappa) * (1 - avg) + (a.kappa + b.kappa) / 2 * avg) * 10.5, sy = Math.max(Math.abs(Math.tan(a.alpha)), Math.abs(Math.tan(b.alpha))) * 8.6;
      const cap = o.tcSlip ?? 2.4, sxMax = Math.max(o.tcFloor ?? 0.3, Math.sqrt(Math.max(0, cap * cap - sy * sy)));
      const tcKi = o.tcKi ?? 8;
      if (tcKi) {
        // Integrating ceiling: the throttle limit moves with the slip error at a rate slower than the wheel's own spin-up,
        // so the loop settles on the slip target instead of cycling against the wheel (a per-frame cut does: the slip
        // swings 3 → 0 → 3 at 10 Hz and the throttle with it).
        this.tcCeil = this.thr > 0.05 ? clamp((this.tcCeil ?? 1) + (sxMax - sx) * tcKi * dt, o.tcMin ?? 0.2, 1) : 1;
        this.thr = Math.min(this.thr, this.tcCeil);
      } else if (sx > sxMax) this.thr *= o.tcRate ? clamp(1 - (sx - sxMax) * o.tcRate * dt, 0.5, 1) : clamp(1 - (sx - sxMax) * (o.tcGain ?? 1.2), 0.25, 1);
      this.tcCut = sx > sxMax;
    }
    car.controls = { throttle: this.thr, brake: this.brk, steer: cmd };
    this.lastCmd = cmd;
    this.trace = { v, vNow, vAhead, want, grip, e: loc.e, beta, slide, lateral: this.lateral, cap: fight.cap, latCap, err, spare: this.spare };
    return car.controls;
  }

  /**
   * Path tracking. The car is steered by what the path needs of it, not by a point it chases: the lateral
   * acceleration of the path's own curvature a moment ahead (the steering and the yaw take that long to answer),
   * plus a critically damped pull back onto the path for any offset and heading error. The car's measured steady
   * response turns that acceleration into a wheel angle, and the yaw rate is held to the one the acceleration goes
   * with, which damps the transients. Nothing past the tyres' measured peak is ever asked for: a corner that wants
   * more is a speed error, and more lock would only scrub (or, on a light rear, start the slide it then has to catch).
   */
  track_(car, line, loc, v, hv, err, dt, tyre) {
    const o = this.options, lat = this.lateral, ds = line.ds;
    const P = (d) => line.point(loc.i, loc.f, d, lat);
    // Path heading at the car, and its curvature (+ turns the way + steering does) over a short window ahead.
    const a = P(-3), b = P(3), head = Math.atan2(b.x - a.x, b.z - a.z), he = angle(hv - head);
    const lead = v * (o.ffLead ?? 0.1), span = Math.max(4, Math.min(10, v * 0.12));
    let kff = 0, nk = 0;
    for (let d = lead - span; d <= lead + span + 1e-6; d += span / 2, nk++) kff += curvatureAt(P, d, Math.max(o.kChord ?? 6, ds, v * (o.kChordT ?? 0.15)));
    kff /= nk;
    // Pull back onto the path over a distance, not a time: the same correction is gentle at any speed (a time
    // constant asks a crawling car for full lock). Critically damped in distance: offset over look², heading
    // (relative to the lane's own sideways motion) over look. Never more than a share of the grip.
    const look = clamp((o.look0 ?? 7) + v * (o.lookT ?? 0.5), 8, 32), zeta = o.zeta ?? 1;
    const hrel = he - (v > 2 ? (this.laneV ?? 0) / v : 0), peak = at(this.env.lat, v) * tyre, fb = (o.fbShare ?? 0.45) * peak / Math.max(4, v * v);
    let k = kff - clamp(err / (look * look) + 2 * zeta * hrel / look, -fb, fb);
    // Lateral jerk: the curvature asked of the car moves no faster than the tyres build force cleanly.
    if (Number.isFinite(this.kc) && v > 3) { const dk = (o.steerJerk ?? 150) * dt / (v * v); k = this.kc + clamp(k - this.kc, -dk, dk); }
    this.kc = k;
    // Nothing past the tyres' real peak here: more lock would only scrub (a corner that wants more is a speed error).
    const ay = clamp(v * v * k, -peak * (o.ayCap ?? 1), peak * (o.ayCap ?? 1));
    const ss = steadySteer(this.env, ay / Math.max(0.5, tyre), v);
    // Yaw rate held to the one this acceleration goes with (damps the transient), and body slip beyond what the
    // car runs steadily at this load fed back, so a rear that steps out is met at once, by a little.
    // The steady body slip climbs steeply near the peak (a few per cent of lateral acceleration is degrees of slip),
    // so the reference is low-passed at the chassis's own response rate, and a slip the car's measured lateral
    // acceleration accounts for is not a slide (the reference may lag a car that is already where it should be).
    const rate = o.bRefRate ?? 8;
    this.bRef = rate && Number.isFinite(this.bRef) ? this.bRef + (ss.beta - this.bRef) * Math.min(1, dt * rate) : ss.beta;
    const beta = Math.atan2(car.v, Math.max(2, car.u)), band = o.slipBand ?? 0.02;
    let slip = beta - this.bRef;
    if (o.stateSlip) { const sm = beta - steadySteer(this.env, car.ay / Math.max(0.5, tyre), v).beta; if (Math.abs(sm) < Math.abs(slip)) slip = Math.sign(slip) * Math.abs(sm) * (Math.sign(sm) === Math.sign(slip) ? 1 : 0); }
    const slide = Math.sign(slip) * Math.max(0, Math.abs(slip) - band);
    const yawT = (o.yawGain ?? 0.38) * (v > 3 ? ay / v - car.yawRate : 0), slideT = (o.slideGain ?? 2.4) * slide;
    this.trace_ = { kff, he, ay, slip, ff: ss.delta, yawT, slideT };
    return ss.delta + yawT + slideT;
  }

  /**
   * Self-check on the exact model. The game's physics are deterministic, so a copy of this car driven by a copy of
   * this driver shows where the next second and a half really goes, in the lane the driver is holding now. If that
   * future slides or leaves the road the pace comes down a notch at a time until a clean one exists; while it is
   * clean the pace creeps back to the plan. Rivals are not in the copy: this guards the car's own control.
   */
  govern(car) {
    const o = this.options, step = o.guardStep ?? 0.03, lo = o.guardLo ?? 0.85, want = this.laneHold ?? 0;
    // A lane the copy cannot drive cleanly is refused while the lane the car is in still can be: it holds where it is.
    this.veto = null;
    let lane = want;
    if (Math.abs(want - this.lateral) > 0.3 && this.rollout(car, this.gp, want) > 0 && this.rollout(car, this.gp, this.lateral) === 0) { this.veto = this.lateral; lane = this.lateral; }
    const now = this.rollout(car, this.gp, lane);
    if (now === 0) { const up = Math.min(1, this.gp + (o.guardUp ?? 0.01)); if (up > this.gp && this.rollout(car, up, lane) === 0) this.gp = up; return; }
    // The future slides: the highest pace whose future is clean, or failing that the least bad one (a pace cut in
    // mid-corner is itself a weight shift, so a lower pace is not taken unless the copy shows it is better).
    let best = this.gp, bestBad = now;
    for (let p = this.gp - step; p >= lo - 1e-9; p -= step) {
      const bad = this.rollout(car, p, lane);
      if (bad < bestBad - 1e-6) { best = p; bestBad = bad; }
      if (bad === 0) break;
    }
    this.gp = best;
  }
  /** How badly the next o.guardH seconds go in the copy: slip past the limit (rad·s) and any wheel past the kerb. */
  rollout(car, gp, lane) {
    const o = this.options, c = cloneCar(car), d = cloneDriver(this, { forceLane: lane });
    d.isShadow = true; d.gp = gp; this.shadowTrack ??= shadowTrack(this.track);
    const dt = 1 / 120, H = o.guardH ?? 2.2, edge = this.track.halfWidth + this.track.curbWidth * (o.guardKerb ?? 0.5), bmax = o.guardB ?? 0.3;
    let bad = 0;
    for (let t = 0, n = 0; t < H; t += dt, n++) {
      d.update(c, [c], dt, {}); c.step(dt, this.shadowTrack);
      const b = Math.abs(Math.atan2(c.v, Math.max(2, c.u)));
      if (b > bmax) bad += (b - bmax) * dt;
      if (b > 0.7) return bad + 1 + (H - t);
      // A car pushing wide of the lane it is steering for (front tyres past their peak) is failing its plan before
      // it slides: the understeer drift is priced as well.
      const drift = Math.abs(d.trace?.err ?? 0) - (o.guardErr ?? 4);
      if (drift > 0) bad += drift * (o.guardErrCost ?? 0.04) * dt;
      if (n % 6 === 0) { const l = Math.abs(this.track.nearest(c.x, c.z).lateral) - edge; if (l > 0) bad += (0.05 + l) * dt * 6; }
    }
    return bad;
  }

  debug() {
    const t = this.trace, c = this.combat;
    return { architecture: 'ORACLE', intent: this.mode, targetSpeed: t?.vAhead, lineSpeed: t?.vNow, e: t?.e, focus: c?.target?.id ?? null, focusGap: c?.target?.gap ?? null, side: Math.sign(this.lateral || 0),
      sub: c?.target ? `${this.mode.toLowerCase()} #${c.target.id} ${c.target.gap.toFixed(1)} m` : this.mode.toLowerCase() };
  }
  visualDebug() {
    if (!this.loc) return null;
    const pts = [];
    for (let d = 0; d < 160; d += 8) { const p = this.line.point(this.loc.i, this.loc.f, d, this.lateral); pts.push({ x: p.x, z: p.z, v: this.line.sample(this.line.v, this.loc.i, this.loc.f, d) }); }
    return { trackingPoint: pts[2], selectedTrajectory: { points: pts, mode: this.mode, color: '#7cf2ff' } };
  }
}

/** Signed curvature of path P (+ turns as + steering) at distance d, from a chord of h either side. */
function curvatureAt(P, d, h) {
  const a = P(d - h), b = P(d), c = P(d + h);
  const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x), den = Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z) * Math.hypot(c.x - a.x, c.z - a.z);
  return den > 1e-9 ? -2 * cross / den : 0;
}
