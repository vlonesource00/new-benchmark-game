import { CarModel } from './model.js';
import { Line } from './line.js';
import { Racecraft } from './racecraft.js';
import { PitLane, PitAutopilot } from '../../../game/core/pit.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * CLAUDE REVOLUTION driver. Writes only `car.controls`.
 * Layers: line (whole-lap geometry) → speed profile (identified g-g-v) →
 * tracker (curvature feedforward through the identified steer map, yaw-rate
 * and course feedback; profile feedforward braking).
 */
export class RevolutionDriver {
  constructor(track, options = {}, teamState = null) {
    this.track = track; this.options = options; this.teamState = teamState;
    this.model = null; this.line = null; this.lambda = options.lambda ?? null;
    this.mode = 'INIT'; this.targetSpeed = 0; this.steer = 0;
  }
  prepare(car) {
    if (this.line && this.classId === car.classId) return;
    this.classId = car.classId;
    // Corner usage per class: GT3 is rear-limited on power, so it keeps more margin.
    this.lambda = this.options.lambda ?? (car.classId === 'gt' ? 0.94 : 0.95);
    this.model = new CarModel(car.classId);
    this.model.latScale = this.options.latScale ?? 1;
    this.model.brakeScale = this.options.brakeScale ?? 1;
    const baked = this.options.lines?.[this.track.id]?.[car.classId];
    this.line = new Line(this.track, { ds: baked?.ds ?? 4, margin: this.options.margin ?? 0.6 });
    // Braking/cornering trade: GT3 trail-brakes on a rounder envelope than the GTP's diamond.
    this.line.brakeExp = this.options.brakeExp ?? baked?.brakeExp ?? 2;
    if (baked?.px?.length === this.line.N) { this.line.px.set(baked.px); this.line.pz.set(baked.pz); this.line.geometry(); }
    else { this.line.minCurvature(this.options.quickSweeps ?? 800); this.line.minTime(this.model, 1, this.options.quickIterations ?? 3000); }
    this.cursor = -1; this.time = 0;
    this.line.trim = new Float64Array(this.line.N).fill(1);
    if (baked?.trim?.length === this.line.N) this.line.trim.set(baked.trim); this.peak = new Float64Array(this.line.N); this.quiet = new Uint8Array(this.line.N);
    this.racecraft = new Racecraft(this);
    this.refresh(car, true);
  }
  reset() { this.steer = 0; this.sent = null; this.lastRefresh = -1; this.cursor = -1; this.racecraft?.reset(); }
  /** Live grip: compound, wear, temperature and surface scale the identified envelope. */
  refresh(car, force = false) {
    const t = car.wheels.map((w) => w.tyre);
    const wearLoss = Math.max(...t.map((x) => 0.10 * x.wear + 1.2 * Math.max(0, x.wear - 0.72) ** 2));
    const temp = Math.min(...t.map((x) => clamp(1 - ((x.core - (x.optimum ?? 85)) / 105) ** 2, 0.65, 1)));
    const ref = 1.07; // identified on warm softs
    const grip = (t[0].gripScale ?? 1) / ref * (1 - wearLoss) * temp / 0.995 * (1 - (this.track.wetness ?? 0) * 0.36) * (this.track.tempGrip ?? 1);
    if (!force && Math.abs(grip - this.model.grip) < 0.004) return;
    this.model.grip = grip;
    this.lapEstimate = this.line.speeds(this.model, this.lambda);
    // The active lane is re-timed on the same grip, never left on a stale profile.
    this.racecraft?.lane?.speeds(this.model, this.lambda * (this.racecraft.lane.boost ?? 1));
  }
  /**
   * In-lap: peel to the pit-side edge and arrive at the entry at the lane's
   * entry speed, so the host autopilot takes over a settled car. The lane
   * geometry is a private copy; the live track is never touched.
   */
  pitApproach(car, cars, i) {
    const rc = this.racecraft;
    const planned = Boolean(this.teamState?.(car)?.pitPlan || car.race?.pitLap || car.race?.boxThisLap);
    if (!this.pitLane) {
      const t = this.track;
      this.pitLane = new PitLane({ id: t.id, scenario: t.scenario, length: t.length, halfWidth: t.halfWidth, curbWidth: t.curbWidth, finishS: t.finishS, setPitLane() {} }, Math.max(1, cars.length + 1));
    }
    const lane = this.pitLane, toEntry = lane.d(car.s, lane.entry), decel = 0.8 * lane.approachDecel;
    if (!planned || toEntry > 400 || toEntry < 0.3) { if (rc.kind === 'pit') { rc.lane = null; rc.kind = 'line'; } rc.pit = false; return Infinity; }
    // The host governs the approach to its autopilot's speeds (and at Harbor the autopilot
    // takes the wheel at the approach point, on the racing line): meeting them here, with
    // room to brake in a straight line, hands over a settled car instead of one braked mid-turn.
    const span = lane.d(lane.approach, lane.entry), early = lane.cross >= span;
    if (!this.pitTable && this.hostLine) {
      const ap = new PitAutopilot(lane, lane.entry, this.hostLine); ap.track = this.track;
      this.pitTable = []; for (let q = 0; q <= span; q += 5) this.pitTable.push([q, ap.targetSpeed(lane.approach + q, car)]);
    }
    const toAp = toEntry - span, aRun = 5;
    let hostV = Infinity; for (const [q, v] of this.pitTable ?? []) if (q >= -toAp) hostV = Math.min(hostV, Math.sqrt(v * v + 2 * aRun * Math.max(0, toAp + q - 3)));
    const vAt = (d) => Math.min(hostV - 0.5, Math.sqrt(lane.entryV ** 2 + 2 * decel * Math.max(0, d - 2)));
    if (early) { rc.pit = false; return vAt(toEntry); }
    // The peel starts where a cosine move to the edge at the approach speed fits.
    if (this.peelAt === undefined) {
      const delta = Math.abs(lane.edgeLat - this.line.lat[rc.stationOfS(lane.entry)]);
      let D = 80; for (let k = 0; k < 4; k++) D = clamp(Math.PI * vAt(D) * Math.sqrt(delta / 8), 50, 170);
      this.peelAt = D;
    }
    if (toEntry > this.peelAt) { rc.pit = false; return vAt(toEntry); }
    if (rc.kind !== 'pit') {
      rc.lane = this.line.lane(rc.profile(i, rc.offsetAt(i), lane.edgeLat, toEntry + 60, 60, vAt(toEntry), true, toEntry - 4));
      rc.lane.speeds(this.model, this.lambda); rc.kind = 'pit';
    }
    rc.pit = true;
    return vAt(toEntry);
  }
  /**
   * Corner-usage map learnt on the move. A slide past the class threshold
   * trims the usage over the ~80 m that set the entry speed (before it becomes
   * a spin); a lap driven clean at a station gives a little back, up to a cap.
   * Only laps in clear air teach it, so traffic never shapes the map.
   */
  learn(car, i, beta, dt) {
    const line = this.line, N = line.N, gt = car.classId === 'gt';
    this.time += dt;
    if (car.race?.lap !== this.learnLap) {
      if (this.learnLap !== undefined) for (let j = 0; j < N; j++) if (this.quiet[j] && this.peak[j] < 0.1) line.trim[j] = Math.min(gt ? 1.03 : 1.02, line.trim[j] + 0.004);
      this.peak.fill(0); this.quiet.fill(0); this.learnLap = car.race?.lap;
    }
    const rc = this.racecraft, clear = !rc.pit && !rc.rivals.near.some((r) => Math.abs(r.fwd) < 40);
    if (!clear || car.speed < 12) return;
    this.quiet[i] = 1; this.peak[i] = Math.max(this.peak[i], Math.abs(beta));
    if ((Math.abs(beta) > (gt ? 0.24 : 0.15) || this.stability < 0.4) && this.time - (this.lastTrim ?? -9) > 1.5) {
      for (let d = -22; d <= 4; d++) { const j = line.idx(i + d), w = d < -16 ? (d + 23) / 7 : 1; line.trim[j] = Math.max(0.85, line.trim[j] * (1 - 0.025 * w)); }
      this.lastTrim = this.time; this.trims = (this.trims ?? 0) + 1;
      this.refresh(car, true);
    }
  }
  /** Driven-wheel slip budget from tyre heat: off inside the window, 0 = unlimited. */
  thermalBudget(a, b) {
    const o = this.options, over = Math.max(a.core - (a.optimum ?? 85), b.core - (b.optimum ?? 85)) - (o.heatOnset ?? 20);
    if (over <= 0) { if (over < -3) this.tcCap = 1; return 0; }
    return clamp(1.6 - (o.heatSlope ?? 0.04) * over, o.heatFloor ?? 0.8, 1.6);
  }
  /**
   * Where the car will be when these controls land. In a seat worker the
   * answer reaches the car a frame after the state it was computed from (`dt`
   * then spans the frame, not one physics step); steering the car as it was
   * that long ago lags every correction, which is how a slide grows into a
   * spin. The pose and body velocities are carried forward over that delay.
   */
  predict(car, dt) {
    const delay = this.options.delay ?? (dt > 0.0125 ? Math.min(0.05, dt) : 0);
    const r0 = car.yawRate, dr = this.lastR === undefined ? 0 : clamp((r0 - this.lastR) / Math.max(1e-3, this.lastDt ?? dt), -6, 6);
    this.lastR = r0; this.lastDt = dt;
    if (!(delay > 0)) return car;
    const yaw0 = car.yaw, s0 = Math.sin(yaw0), c0 = Math.cos(yaw0);
    // Body accelerations (ax forward, ay right) into the world frame.
    const vx = car.vx + (car.ax * s0 + car.ay * c0) * delay, vz = car.vz + (car.ax * c0 - car.ay * s0) * delay;
    const yawRate = clamp(r0 + dr * delay, -3, 3), yaw = yaw0 + 0.5 * (r0 + yawRate) * delay, s = Math.sin(yaw), c = Math.cos(yaw);
    const u = vx * s + vz * c, v = vx * c - vz * s;
    return Object.create(car, {
      x: { value: car.x + 0.5 * (car.vx + vx) * delay }, z: { value: car.z + 0.5 * (car.vz + vz) * delay },
      yaw: { value: yaw }, yawRate: { value: yawRate }, vx: { value: vx }, vz: { value: vz }, u: { value: u }, v: { value: v }, speed: { value: Math.hypot(u, v) }
    });
  }
  update(real, cars, dt, context) {
    this.prepare(real);
    const car = this.predict(real, dt);
    // Someone else drove the last step (the formation pilot during the handover second):
    // plans must start from where the car really is, not from our own lane.
    this.passive = this.sent !== null && this.sent !== undefined && car.controls?.steer !== this.sent;
    const track = this.track, line = this.line, model = this.model;
    const v = Math.max(0.5, car.speed);
    let c = line.closest(car.x, car.z, this.cursor);
    if (c.d2 > 400) c = line.closest(car.x, car.z, -1);
    this.cursor = c.i;
    this.refreshClock = (this.refreshClock ?? 0) + dt;
    if (this.refreshClock > 0.5) { this.refreshClock = 0; this.refresh(car); }
    // Racecraft picks the lane (the line or a shifted copy sharing its stations) and a traffic speed cap.
    let cap = this.options.racecraft === false ? Infinity : this.racecraft.update(car, cars ?? [], dt, c.i, c.e);
    cap = Math.min(cap, this.pitApproach(car, cars ?? [], c.i));
    const path = this.racecraft.lane ?? line;
    if (path !== line) c = path.closest(car.x, car.z, c.i);
    const { i, f } = c, e = c.e - (this.racecraft.nudge ?? 0);
    // ---- lateral ----
    const hPath = path.heading(i, f);
    const beta = Math.atan2(car.v, Math.max(2, car.u));
    const psi = wrapAngle(car.yaw + beta - hPath);
    const Lp = clamp(0.32 * v + 7, 9, 32);
    const kp = path.sample(path.ks, i, f, v * 0.08);
    const kc = kp - 2 * psi / Lp - e / (Lp * Lp);
    const ay = v * v * kc;
    const ff = model.steerFor(ay, v);
    const rDes = v * kc, rErr = rDes - car.yawRate;
    this.rDes = rDes; this.e = e; this.kp = kp;
    // Sideslip beyond the dead band is caught with countersteer (positive β = sliding right of the nose).
    // Steer 1 is ~0.5 rad of lock, so aligning the fronts with the velocity needs ~2·β.
    const o = this.options, slide = Math.sign(beta) * Math.max(0, Math.abs(beta) - (o.slideBand ?? 0.05));
    this.steer = clamp(ff + (o.yawGain ?? 0.45) * rErr + (o.slideGain ?? 2.2) * slide, -1, 1);
    // Rotation beyond what the path asks for (oversteer) releases the pedals, as an ESC would.
    // Turning against what the path asks counts only by its own rate: a car asked to turn
    // and not yet turning is not oversteering.
    const over = Math.sign(car.yawRate) === Math.sign(rDes) ? Math.max(0, Math.abs(car.yawRate) - Math.abs(rDes)) : Math.abs(car.yawRate);
    const bRate = Math.sign(beta) * ((beta - (this.lastBeta ?? beta)) / Math.max(1e-3, dt)); this.lastBeta = beta;
    this.stability = clamp(1 - 2.5 * Math.max(0, over - 0.08) - 4 * Math.max(0, Math.abs(beta) - (o.betaLimit ?? 0.07)) - (o.betaRateGain ?? 0) * Math.max(0, bRate - 0.25), 0, 1);
    // ---- longitudinal ----
    const look = v * 0.1;
    // Dirty air: where the profile is grip-limited (a corner, or braking for one) it is
    // scaled to the downforce the wake leaves; on the straights the tow is left alone.
    let w0 = path.sample(path.v, i, f, look), w2 = path.sample(path.v, i, f, look + Math.max(4, v * 0.25));
    const wf = model.wakeFactor(v, car.aero?.wake ?? 0);
    if (wf < 1 && (w0 < v + 1 || Math.abs(kp) * w0 * w0 > 0.4 * model.lat(w0))) { const r = Math.sqrt(wf); w0 *= r; w2 *= r; }
    const vt = Math.min(cap, w0), vt2 = Math.min(cap, w2);
    const aProf = (vt2 * vt2 - vt * vt) / (2 * Math.max(4, v * 0.25));
    this.targetSpeed = vt;
    let throttle = 0, brake = 0;
    const err = vt - v;
    if (err > 0.4 || (err > -0.2 && aProf > -1)) throttle = clamp(0.4 + err * 0.9 + aProf * 0.1, 0, 1);
    // A little over a gently falling profile: lift. A car at the limit sheds speed on its
    // own scrub, and a stab of brake mid-corner only unsettles the rear.
    else if (-err < (o.coastBand ?? 2) && -aProf < (o.coastDecel ?? 3)) throttle = 0;
    else {
      const need = Math.max(0, -aProf) / model.brake(v);
      brake = clamp(need + (v - vt) * 0.18, 0, 1);
      if (v < vt - 0.5) brake *= 0.3;
      // Braking for traffic rather than for the line: share the grip with the corner the
      // line is taking here (friction circle), as the line's own braking already does.
      if (cap < w0 - 0.5) { const u = Math.min(1, Math.abs(kp) * v * v / (model.lat(v) * wf)); brake = Math.min(brake, Math.max(0.25, Math.sqrt(1 - u * u))); }
    }
    // Tyre budget on exits: force grows as tanh(slip) but wear as force × slip,
    // so driven-wheel combined slip above the budget buys little drive for a
    // lot of heat. An integrating cap holds it near `slipBudget`.
    // Unset, the budget is thermal: it engages once the driven tyres run well past their
    // window (long laps cook the rears within one lap) and tightens as they heat further.
    const d = car.spec?.drive === 'front' ? 0 : 2;
    const budget = this.options.slipBudget ?? this.thermalBudget(car.wheels[d].tyre, car.wheels[d + 1].tyre);
    if (budget > 0) {
      const sl = (t) => (t.kappa > 0 ? Math.hypot(t.kappa * 10.5, Math.tan(Math.min(1.2, Math.abs(t.alpha))) * 8.6) : 0);
      const rs = Math.max(sl(car.wheels[d].tyre), sl(car.wheels[d + 1].tyre));
      this.tcCap = clamp((this.tcCap ?? 1) + dt * (rs > budget ? -12 * (rs - budget) - 1 : 1.5), 0.15, 1);
      throttle = Math.min(throttle, this.tcCap);
    }
    brake *= this.stability; throttle *= this.stability;
    if (this.options.learn !== false) this.learn(car, i, beta, dt);
    if (throttle > 0.99 && Math.abs(car.steering) < 0.03 && car.gear > 0 && !car.shiftTimer) model.observeDrive(v, car.ax);
    this.mode = brake > 0 ? 'BRAKE' : throttle > 0.95 ? 'PUSH' : 'CORNER';
    real.controls = { throttle, brake, steer: this.steer }; this.sent = this.steer;
  }
}
