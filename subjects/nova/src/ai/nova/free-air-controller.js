// NOVA Free-Air Controller (alpha)
//
// A live controller for free-air running. It is NOT the legacy DeepSeekAI: the
// legacy stack (global line -> local plan -> tracker -> longitudinal ->
// supervisor) remains available untouched as LEGACY_BASELINE and is used only
// as a fallback when this controller fails.
//
// Structure:
//   * reference   - host-exact Harbor geometry + certified quasi-steady speed
//                   profile produced by tools/bake-nova-reference.py
//   * steering    - pure pursuit on the reference path with yaw-rate damping
//                   and an actuator rate limit, converted through the kinematic
//                   bicycle so the command is a real steering angle
//   * longitudinal- a short horizon (T seconds) is walked along the reference;
//                   the coupled constraint is applied at every horizon point as
//                   a friction-ellipse budget a_avail = A(v) * sqrt(1 - uy^2)
//                   with uy = v^2|kappa| / latMax(v). The requested acceleration
//                   is the one that reaches the reference speed at the horizon
//                   end, clamped by the tightest budget on the way. This couples
//                   steering and force through the same tyre budget.
//   * safety      - corridor guard, stability guard, NaN/exception guard that
//                   hands control to the fallback.
//
// Realtime: O(8) horizon steps, no allocation in the loop.

import { clamp, angle } from '../../sim/math.js';

const HORIZON_S = 1.2;
const HORIZON_STEPS = 8;
const GRIP_MARGIN = 0.9;

export class NOVAFreeAirController {
  constructor({ reference, envelope, options = {}, fallback = null, model = null }) {
    this.ref = reference;
    this.envelope = envelope;
    this.options = options;
    this.fallback = fallback;
    this.model = model ?? null;
    this.ds = reference.ds;
    this.n = reference.n;
    this.wheelbase = options.wheelbase ?? 2.78;
    this.maxSteer = options.maxSteer ?? 0.5;
    this.steerRate = options.steerRate ?? 3.0;
    this.speedScale = options.speedScale ?? 1;
    this.strict = Boolean(options.strict);
    this.failed = false;
    this.strictFail = null;
    this.fallbackCount = 0;
    this.firstFallbackTime = null;
    this.firstFallbackReason = null;
    this.novaTime = 0;
    this.legacyTime = 0;
    this.trace = null;
    this.lastSteer = 0;
    this.state = {
      mode: 'NOVA', steer: 0, targetSpeed: 0, horizonSpeed: 0, accel: 0,
      uyMax: 0, brake: 0, throttle: 0, elat: 0, ehead: 0, reason: null,
    };
  }

  reset() {
    this.failed = false;
    this.lastSteer = 0;
    if (this.fallback?.reset) this.fallback.reset();
  }

  /** Legacy-shaped read-only view so the lap recorder, debugger and UI can
   *  read a line without knowing which controller is driving. Resampled onto the
   *  track model's own station grid, because consumers index by model station. */
  get line() {
    if (!this._lineView) {
      const ref = this.ref;
      const m = this.model;
      if (m && m.n && m.s) {
        const q = new Float64Array(m.n), kappa = new Float64Array(m.n);
        const heading = new Float64Array(m.n), v = new Float64Array(m.n);
        for (let i = 0; i < m.n; i++) {
          const k = Math.max(0, Math.min(ref.n - 1, Math.round(m.s[i] / ref.ds)));
          q[i] = ref.q[k]; kappa[i] = ref.kappa[k]; heading[i] = ref.heading[k]; v[i] = ref.v[k];
        }
        this._lineView = { q, path: { kappa, heading, n: m.n, px: ref.x, pz: ref.z }, profile: { v, time: ref.referenceTime }, envelope: this.envelope };
      } else {
        this._lineView = {
          q: ref.q, path: { kappa: ref.kappa, heading: ref.heading, n: ref.n },
          profile: { v: ref.v, time: ref.referenceTime }, envelope: this.envelope,
        };
      }
    }
    return this._lineView;
  }

  /** Reference station index and interpolated fields. */
  sample(s) {
    const ref = this.ref;
    const x = ((s % ref.length) + ref.length) % ref.length / this.ds;
    const i = Math.floor(x) % this.n;
    const j = (i + 1) % this.n;
    const t = x - Math.floor(x);
    return {
      i, j, t,
      v: ref.v[i] + (ref.v[j] - ref.v[i]) * t,
      kappa: ref.kappa[i] + (ref.kappa[j] - ref.kappa[i]) * t,
      q: ref.q[i] + (ref.q[j] - ref.q[i]) * t,
      heading: ref.heading[i] + angle(ref.heading[j] - ref.heading[i]) * t,
      x: ref.x[i] + (ref.x[j] - ref.x[i]) * t,
      z: ref.z[i] + (ref.z[j] - ref.z[i]) * t,
    };
  }

  step(obs) {
    if (this.strictFail) {
      if (this.options?.trace) this.record(obs, 'STRICT_STOP', null);
      return { steer: 0, throttle: 0, brake: 0.3, reverse: false };
    }
    if (this.failed) return this.fallbackCommand(obs, 'nova-failed');
    const ego = obs.ego;
    const here = this.sample(ego.s);
    const qErr = Math.abs(ego.q - here.q);
    const hErr = Math.abs(angle(ego.yaw - here.heading));
    // Guard reasons are kept separate: physical stability against the HOST
    // geometry, alignment against the NOVA REFERENCE, and yaw/slip health.
    const gi = this.model ? this.model.index(ego.s) : null;
    const hostHeading = gi !== null && this.model.heading ? this.model.heading[gi] : here.heading;
    const hHost = Math.abs(angle(ego.yaw - hostHeading));
    // Acquisition: the car starts on the canonical grid, which can be several
    // metres laterally and in heading away from the reference. Until the merge
    // completes, only physical-stability reasons may trigger; the reference
    // alignment reasons are held back.
    if (!this.startS) this.startS = ego.s;
    if (!this.acquired) {
      this.acquireT = (this.acquireT ?? 0) + obs.dt;
      const travelled = Math.abs(ego.s - this.startS);
      if (this.acquireT > 2.5 || travelled > 70) this.acquired = true;
    }
    let reason = null;
    if (Math.abs(ego.q) > 7.0) reason = 'HOST_OFF_CORRIDOR';
    else if (hHost > 0.9) reason = 'HOST_HEADING_UNSTABLE';
    else if (Math.abs(ego.yawRate) > 2.2) reason = 'EXCESS_YAW';
    else if (this.acquired && hErr > 0.7) reason = 'REFERENCE_HEADING_MISMATCH';
    else if (this.acquired && qErr > 3.5) reason = 'REFERENCE_LATERAL_MISMATCH';
    if (!this.started && ego.speed > 5) this.started = true;
    if (reason) this.guardReason = reason;
    const dirty = this.started && reason !== null;
    if (dirty) {
      this.recoverTime = 0;
      this.recovering = true;
      this.fallbackCount++;
      if (this.firstFallbackTime === null) {
        this.firstFallbackTime = this.time ?? 0;
        this.firstFallbackReason = reason;
      }
    } else if (this.recovering) {
      this.recoverTime = (this.recoverTime ?? 0) + obs.dt;
      if (this.recoverTime > 1.5 && Math.abs(ego.q) < 3.5 && Math.abs(ego.yawRate) < 0.8) this.recovering = false;
    }
    if (this.options?.trace) this.record(obs, reason, dirty ? 'guard' : this.recovering ? 'guard' : 'nova');
    if (this.strict) {
      if (dirty) {
        this.strictFail = { time: this.time ?? 0, reason, q: ego.q, speed: ego.speed,
                            yawRate: ego.yawRate, hHost, hErr, qErr };
        this.state.mode = 'STRICT_FAIL';
        this.state.reason = reason;
        return { steer: 0, throttle: 0, brake: 0.3, reverse: false };
      }
    } else if (this.recovering) {
      this.state.mode = 'GUARD';
      this.state.reason = reason ?? 'handover';
      return this.fallbackCommand(obs, 'guard');
    }
    try {
      const cmd = this.compute(obs);
      if (!Number.isFinite(cmd.steer) || !Number.isFinite(cmd.throttle) || !Number.isFinite(cmd.brake)) {
        throw new Error('INVALID_COMMAND');
      }
      this.novaTime += obs.dt;
      if (this.options?.trace) this.record(obs, reason, 'nova', true);
      return cmd;
    } catch (err) {
      // In strict mode an exception TERMINATES the diagnostic: NOVA must never be
      // able to hide a failure behind LEGACY_BASELINE.
      const info = {
        type: 'COMPUTE_EXCEPTION', message: String(err && err.message ? err.message : err),
        stack: String(err && err.stack ? err.stack.split('\n').slice(1, 4).join(' | ') : ''),
        time: this.time ?? 0, s: obs.ego?.s, q: obs.ego?.q, speed: obs.ego?.speed,
        yaw: obs.ego?.yaw, yawRate: obs.ego?.yawRate,
      };
      if (this.options?.trace) this.record(obs, reason, 'exception', false, info);
      if (this.strict) {
        this.strictFail = info;
        this.state.mode = 'STRICT_FAIL';
        this.state.reason = info.message;
        return { steer: 0, throttle: 0, brake: 0.3, reverse: false };
      }
      this.failed = true;
      this.state.reason = info.message;
      return this.fallbackCommand(obs, 'nova-error');
    }
  }

  /** Rolling telemetry for the strict diagnostic. */
  record(obs, reason, owner, computeSucceeded, exception) {
    const ego = obs.ego;
    const here = this.sample(ego.s);
    this.trace ??= [];
    if (this.trace.length > 900) return;
    this.time = (this.time ?? 0) + obs.dt;
    const gi = this.model ? this.model.index(ego.s) : null;
    this.trace.push({
      t: +this.time.toFixed(4), s: +ego.s.toFixed(2), q: +ego.q.toFixed(3),
      speed: +ego.speed.toFixed(3), yaw: +ego.yaw.toFixed(4), yawRate: +ego.yawRate.toFixed(4),
      hostHeading: gi !== null && this.model.heading ? +this.model.heading[gi].toFixed(4) : null,
      refHeading: +here.heading.toFixed(4), refQ: +here.q.toFixed(3),
      refKappa: +here.kappa.toFixed(5), refSpeed: +here.v.toFixed(3),
      steer: +this.lastSteer.toFixed(4), throttle: +(this.state.throttle ?? 0).toFixed(3),
      brake: +(this.state.brake ?? 0).toFixed(3), accelCmd: +(this.state.accel ?? 0).toFixed(3),
      uyMax: +(this.state.uyMax ?? 0).toFixed(3), owner, reason,
      computeSucceeded: computeSucceeded === undefined ? null : computeSucceeded,
      exceptionType: exception?.type ?? null, exceptionMessage: exception?.message ?? null,
    });
  }

  fallbackCommand(obs, reason) {
    this.state.mode = 'FALLBACK';
    this.state.reason = reason;
    this.legacyTime = (this.legacyTime ?? 0) + obs.dt;
    this.fallbackCount++;
    if (this.firstFallbackTime === null) {
      this.firstFallbackTime = this.time ?? 0;
      this.firstFallbackReason = reason;
    }
    if (this.fallback?.step) return this.fallback.step(obs);
    return { steer: 0, throttle: 0, brake: 0.35, reverse: false };
  }

  compute(obs) {
    const dt = obs.dt;
    const ego = obs.ego;
    const ref = this.ref;
    const v = ego.speed;

    // ---- grip scaling from the plant's own tyre state (cold tyres have less)
    let tyreScale = 1;
    if (ego.tyres?.length) {
      let f = 0;
      for (const t of ego.tyres) f += (t.core ?? 85) >= 85 ? 1 : 0.8 + 0.2 * ((t.core ?? 85) - 25) / 60;
      tyreScale = clamp(f / ego.tyres.length, 0.75, 1);
    }
    const scale = clamp(this.speedScale * tyreScale, 0.5, 1);

    // ---- steering: pure pursuit on the reference world path. The command is
    // normalised by the car's steering lock, matching the plant convention
    // (verified: positive steering increases yaw, heading = atan2(tx, tz)).
    const spec = ego.spec ?? {};
    const wheelbase = spec.wheelbase ?? this.wheelbase;
    const lock = spec.steeringLock ?? this.maxSteer;
    const look = clamp(0.65 * v, 5, 22);
    const target = this.sample(ego.s + look);
    const dx = target.x - ego.x, dz = target.z - ego.z;
    const travelled = Math.max(3, Math.hypot(dx, dz));
    const alpha = angle(Math.atan2(dx, dz) - ego.yaw);
    const pp = Math.atan2(2 * wheelbase * Math.sin(alpha), travelled);
    const here = this.sample(ego.s);
    const kappaRef = here.kappa;
    const yawRef = v * kappaRef;          // reference yaw-rate expectation
    const ff = Math.atan(wheelbase * kappaRef) + 0.0008 * v * v * kappaRef;
    const damp = -0.22 * (ego.yawRate - v * kappaRef);
    const steerRaw = pp + ff + damp;
    let steer = clamp(steerRaw / lock, -1, 1);
    const maxStep = (this.steerRate / lock) * dt;
    steer = this.lastSteer + clamp(steer - this.lastSteer, -maxStep, maxStep);
    steer = clamp(steer, -1, 1);
    this.lastSteer = steer;

    // ---- longitudinal: build horizon samples at PHYSICAL cumulative distances,
    // then run a BACKWARD braking-viability pass (the same structure as the
    // offline fixed-path solver). No time/distance unit mixing: the kinematic
    // relation uses distance, not remaining time.
    const dtH = HORIZON_S / HORIZON_STEPS;
    const N = HORIZON_STEPS;
    const sPred = new Array(N + 1), vRefH = new Array(N + 1), dsH = new Array(N), brkH = new Array(N);
    let s = ego.s;
    let vh = Math.max(1, v);
    let uyMax = 0, infeasible = 0;
    for (let k = 0; k <= N; k++) {
      const smp = this.sample(s);
      sPred[k] = s;
      vRefH[k] = Math.max(1, smp.v * scale);
      if (k < N) {
        const uyRaw = vh * vh * Math.abs(smp.kappa) / Math.max(1e-6, this.latMax(vh));
        uyMax = Math.max(uyMax, uyRaw);
        if (uyRaw > 1) infeasible++;
        const frac = uyRaw >= 1 ? 0 : Math.sqrt(1 - uyRaw * uyRaw);
        brkH[k] = this.brakeMax(vh) * frac * GRIP_MARGIN;
        const ds = Math.max(0.5, vh * dtH);
        dsH[k] = ds;
        s += ds;
        vh = Math.max(1, Math.min(vh + this.driveMax(vh) * frac * GRIP_MARGIN * dtH, vRefH[k]));
      }
    }
    const vAllow = new Array(N + 1);
    vAllow[N] = vRefH[N];
    for (let k = N - 1; k >= 0; k--) {
      vAllow[k] = Math.min(vRefH[k], Math.sqrt(Math.max(1, vAllow[k + 1] * vAllow[k + 1] + 2 * brkH[k] * dsH[k])));
    }
    // Coupled budget at the CURRENT state. Infeasibility must be judged HERE:
    // zeroing drive because a *predicted* horizon sample momentarily exceeds the
    // ellipse removed all acceleration authority (the car would not pull).
    const uyNow = v * v * Math.abs(here.kappa) / Math.max(1e-6, this.latMax(v));
    const fracNow = uyNow >= 1 ? 0 : Math.sqrt(1 - uyNow * uyNow);
    const budgetDrive = this.driveMax(v) * fracNow * GRIP_MARGIN;
    const budgetBrake = brkH.length ? Math.min(...brkH) : this.brakeMax(v);
    const ahead = this.sample(ego.s + Math.max(20, v * HORIZON_S));
    const acquireCap = this.acquired ? Infinity : 16;
    const vTarget = Math.max(1, Math.min(ahead.v * scale, acquireCap, vAllow[0]));
    const dist2 = Math.max(5, v * HORIZON_S);
    let accel = (vTarget * vTarget - v * v) / (2 * dist2);
    accel += clamp(0.55 * (vTarget - v), -1.5, 1.5);
    // braking viability over the horizon: never stay above what the horizon can
    // still brake from
    if (v > vAllow[0] + 0.1) {
      accel = Math.min(accel, -(v * v - vAllow[0] * vAllow[0]) / (2 * Math.max(5, 0.35 * v)));
    }
    accel = clamp(accel, -budgetBrake, budgetDrive);
    // stability guard: no full power while the car is rotating faster than the
    // reference rate allows
    // stability guard: only meaningful once moving. Firing at launch braked the
    // car instead of letting it pull away.
    if (v > 8 && Math.abs(ego.yawRate) > Math.max(1.2, 2 * Math.abs(yawRef))) accel = Math.min(accel, -0.6);
    // corridor guard: slow down if the car is being carried wide
    const corridorQ = Math.abs(ego.q);
    if (corridorQ > 6.0) accel = Math.min(accel, -1.2);

    const throttle = accel >= 0 ? clamp(accel / Math.max(1e-6, this.driveMax(v)), 0, 1) : 0;
    const brake = accel < 0 ? clamp(-accel / Math.max(1e-6, this.brakeMax(v)), 0, 1) : 0;

    this.state.steer = steer;
    this.state.targetSpeed = vTarget;
    this.state.horizonSpeed = vh;
    this.state.accel = accel;
    this.state.uyMax = uyMax;
    this.state.brake = brake;
    this.state.throttle = throttle;
    this.state.elat = ego.q - here.q;
    this.state.ehead = angle(ego.yaw - here.heading);
    this.state.mode = 'NOVA';
    this.state.reason = null;
    // Legacy-shaped diagnostics so the Race Engineer debugger and UI read sane
    // values instead of undefined (they were built against DeepSeekAI's state).
    this.state.rlat = this.state.elat;
    this.state.rhead = this.state.ehead;
    this.state.pp = pp;
    this.state.ff = ff;
    this.state.damp = damp;
    this.state.kappaRef = kappaRef;
    this.state.requiredAccel = Math.max(0, accel);
    this.state.requiredDecel = Math.max(0, -accel);
    this.state.plannedBrake = brake > 0;
    this.state.horizonSpeed = vh ?? v;
    this.state.speedScale = scale;
    this.state.vGrip = Math.sqrt(Math.max(1, this.latMax(v) / Math.max(1e-6, Math.abs(kappaRef))));
    this.state.intent = 'PACE';
    this.state.cause = null;
    this.state.supervisor = false;
    this.state.localElat = this.state.elat;
    this.state.localEhead = this.state.ehead;
    this.state.yawRateError = ego.yawRate - yawRef;
    this.state.beta = ego.beta ?? 0;
    return { steer, throttle, brake, reverse: false };
  }

  // ---- capability helpers: prefer the envelope, fall back to the reference curves
  latMax(v) {
    const e = this.envelope;
    if (e?.latMax) return e.latMax(v);
    return 14;
  }

  driveMax(v) {
    const e = this.envelope;
    let a = 0;
    if (e?.driveForce) {
      const f = e.driveForce(v);
      a = f > 50 ? f / (e.mass ?? 1310) : f;
    } else {
      a = Math.max(0.5, 8 - 0.06 * v);
    }
    // The identified curve is measured from 8 m/s up, so extrapolating it to a
    // standing start returns ~0.5 m/s^2 and the car cannot pull away. A launch
    // floor is a documented plant-model allowance, not a pace fudge.
    return Math.max(a, v < 12 ? 4.5 : 1.0);
  }

  brakeMax(v) {
    const e = this.envelope;
    if (e?.brakeForce) {
      const f = e.brakeForce(v);
      return Math.max(1, f > 50 ? f / (e.mass ?? 1310) : f);
    }
    return Math.max(1, 12 + 0.04 * v);
  }
}
