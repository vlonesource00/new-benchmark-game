import { clamp, angle } from '../../sim/math.js';
import { gripFactor } from '../../sim/tyre.js';
import { mengerCurvature } from '../global/spatial-oracle.js';

export const TARGET_LIMIT_REASON = Object.freeze({
  REFERENCE_PROFILE: 'REFERENCE_PROFILE',
  REFERENCE_SPEED_OVERRIDDEN_UPWARD: 'REFERENCE_SPEED_OVERRIDDEN_UPWARD',
  GRIP_LIMIT: 'GRIP_LIMIT',
  BRAKING_ENVELOPE: 'BRAKING_ENVELOPE',
  SPEED_SCALE: 'SPEED_SCALE',
  TRAFFIC: 'TRAFFIC',
  STABILITY: 'STABILITY',
  TYRE_STATE: 'TYRE_STATE',
  NONE: 'NONE',
});

export const THROTTLE_LIMIT_REASON = Object.freeze({
  TARGET_REACHED: 'TARGET_REACHED',
  UPCOMING_BRAKING: 'UPCOMING_BRAKING',
  FRONT_GRIP: 'FRONT_GRIP',
  REAR_GRIP: 'REAR_GRIP',
  COMBINED_GRIP: 'COMBINED_GRIP',
  YAW_STABILITY: 'YAW_STABILITY',
  TRACTION: 'TRACTION',
  ACTUATOR: 'ACTUATOR',
  ENGINE: 'ENGINE',
  THERMAL: 'THERMAL',
  TRAFFIC: 'TRAFFIC',
  NONE: 'NONE',
});

export const BRAKE_REASON = Object.freeze({
  UPCOMING_SPEED_CONSTRAINT: 'UPCOMING_SPEED_CONSTRAINT',
  ACTUAL_OVERSPEED: 'ACTUAL_OVERSPEED',
  STABILITY: 'STABILITY',
  TRAFFIC: 'TRAFFIC',
  TRACK_EMERGENCY: 'TRACK_EMERGENCY',
  NONE: 'NONE',
});

export class NovaCoupledController {
  constructor({ reference, envelope, options = {}, fallback = null, model = null, line = null }) {
    this.ref = reference;
    this.envelope = envelope;
    this.options = options;
    this.fallback = fallback; // Kept for API compatibility, but we don't rigidly use it
    this.model = model ?? null;
    this._explicitLine = line ?? null;
    this.ds = reference.ds;
    this.n = reference.n;
    this.wheelbase = options.wheelbase ?? 2.78;
    this.maxSteer = options.maxSteer ?? 0.5;
    this.steerRate = options.steerRate ?? 3.0;
    this.speedScale = options.speedScale ?? 1;
    this.lastSteer = 0;
    this.isBraking = false;
    this.activeBrakingEventId = null;
    this.brakingTargetSpeed = 0;
    this.brakingStation = 0;
    this.brakingPhase = 'NONE';
    this.brakeCooldown = 0;
    this.lastBeta = null;
    this.betaDot = 0;
    this.trackedTacticalOffset = 0;
    this.tractionRegulation = 1.0;
    this.disableOfflineDerating = options.disableOfflineDerating ?? false;

    // Configurable performance margins (Wave P2-P4)
    this.gripMarginTight = options.gripMarginTight ?? 0.95;
    this.gripMarginMid = options.gripMarginMid ?? 0.97;
    this.gripMarginOpen = options.gripMarginOpen ?? 0.99;
    this.brakeMargin = options.brakeMargin ?? 0.96;
    this.brakeNominalFactor = options.brakeNominalFactor ?? 0.91;
    this.speedOvershootFactor = options.speedOvershootFactor ?? 0.98;
    this.cornerMaintMax = options.cornerMaintMax ?? 0.55;
    this.driveBudgetMargin = options.driveBudgetMargin ?? 0.96;
    this.brakeBudgetMargin = options.brakeBudgetMargin ?? 0.96;
    this.lookaheadGain = options.lookaheadGain ?? 0.54;
    this.lookaheadMin = options.lookaheadMin ?? 8.5;
    this.lookaheadMax = options.lookaheadMax ?? 26.0;
    this.steerFeedforward = options.steerFeedforward ?? 0.90;
    this.yawDampCoeff = options.yawDampCoeff ?? -0.20;
    this.understeerCoeff = options.understeerCoeff ?? 0.0006;
    this.enableDynamicStability = options.enableDynamicStability ?? true;
    this.yawStabilityThreshold = options.yawStabilityThreshold ?? 1.05;
    this.yawErrorThreshold = options.yawErrorThreshold ?? 0.50;
    this.cornerExitAggression = options.cornerExitAggression ?? 0.7;
    this.boundaryMarginGuard = options.boundaryMarginGuard ?? true;
    this.boundaryThreshold = options.boundaryThreshold ?? 6.5;
    this.boundaryGain = options.boundaryGain ?? 0.15;
    this.throttleGain = options.throttleGain ?? 3.5;

    this.state = {
      mode: 'NOVA_COUPLED',
      steer: 0,
      targetSpeed: 0,
      horizonSpeed: 0,
      accel: 0,
      uyMax: 0,
      brake: 0,
      throttle: 0,
      elat: 0,
      ehead: 0,
      reason: null,
      targetLimitReason: TARGET_LIMIT_REASON.NONE,
      throttleLimitReason: THROTTLE_LIMIT_REASON.NONE,
      brakeReason: BRAKE_REASON.NONE,
      clearFullThrottleEligible: false,
      brakingMarginMeters: 0,
    };

    // Preallocated buffers for real-time horizon DP pass (zero GC churn at 120 Hz)
    this.HORIZON_STEPS = 36;
    this.sPred = new Float64Array(this.HORIZON_STEPS + 1);
    this.vRefH = new Float64Array(this.HORIZON_STEPS + 1);
    this.brkH = new Float64Array(this.HORIZON_STEPS);
    this.dsH = new Float64Array(this.HORIZON_STEPS);
    this.vAllow = new Float64Array(this.HORIZON_STEPS + 1);
    this._horizonSample = { i: 0, j: 0, t: 0, v: 0, kappa: 0, q: 0, heading: 0, x: 0, z: 0 };

    // Precomputed distance to next slow corner (|kappa| > 0.012) for open-sector speed rollout
    this.distToSlowCorner = new Float64Array(this.n);
    const L_track = this.ref.length;
    for (let i = 0; i < this.n; i++) {
      const s_i = i * this.ds;
      let dFound = 250;
      for (let d = 5; d <= 250; d += 5) {
        const sCheck = (s_i + d) % L_track;
        const k = Math.round(sCheck / this.ds) % this.n;
        if (Math.abs(this.ref.kappa[k]) > 0.012) {
          dFound = d;
          break;
        }
      }
      this.distToSlowCorner[i] = dFound;
    }
  }

  reset() {
    this.lastSteer = 0;
    this.isBraking = false;
    this.activeBrakingEventId = null;
    this.brakingTargetSpeed = 0;
    this.brakingStation = 0;
    this.brakingPhase = 'NONE';
    this.brakeCooldown = 0;
    this.lastBeta = null;
    this.betaDot = 0;
    this.trackedTacticalOffset = 0;
    this.tractionRegulation = 1.0;
  }

  sample(s, out = null) {
    const ref = this.ref;
    const safeS = Number.isFinite(s) ? s : 0;
    const x = ((safeS % ref.length) + ref.length) % ref.length / this.ds;
    const i = Math.floor(x) % this.n;
    const j = (i + 1) % this.n;
    const t = x - Math.floor(x);
    if (out) {
      out.i = i; out.j = j; out.t = t;
      out.v = ref.v[i] + (ref.v[j] - ref.v[i]) * t;
      out.kappa = ref.kappa[i] + (ref.kappa[j] - ref.kappa[i]) * t;
      out.q = ref.q[i] + (ref.q[j] - ref.q[i]) * t;
      out.heading = ref.heading[i] + angle(ref.heading[j] - ref.heading[i]) * t;
      out.x = ref.x[i] + (ref.x[j] - ref.x[i]) * t;
      out.z = ref.z[i] + (ref.z[j] - ref.z[i]) * t;
      return out;
    }
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

  get line() {
    if (this._explicitLine) return this._explicitLine;
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
          q: ref.q, path: { kappa: ref.kappa, heading: ref.heading, n: ref.n, px: ref.x, pz: ref.z },
          profile: { v: ref.v, time: ref.referenceTime }, envelope: this.envelope,
        };
      }
    }
    return this._lineView;
  }

  step(obs, topologyResult = null) {
    const dt = obs.dt;
    const ego = obs.ego;
    const v = ego.speed;
    const cy = Math.cos(ego.yaw ?? 0), sy = Math.sin(ego.yaw ?? 0);
    const uLong = ego.u !== undefined ? ego.u : ((ego.vx ?? 0) * sy + (ego.vz ?? 0) * cy);
    const vLat = ego.v !== undefined ? ego.v : ((ego.vx ?? 0) * cy - (ego.vz ?? 0) * sy);
    const carBeta = Math.atan2(vLat, Math.max(0.1, Math.abs(uLong)));
    const dtSafe = Math.max(1e-4, dt);
    const betaDot = (carBeta - (this.lastBeta ?? carBeta)) / dtSafe;
    this.lastBeta = carBeta;
    this.betaDot = betaDot;
    const absBeta = Math.abs(carBeta);
    const betaDiverging = (carBeta * betaDot) > 0.015;
    const egoQVal = Number.isFinite(ego.q) ? ego.q : (Number.isFinite(ego.lateral) ? ego.lateral : 0);
    const here = this.sample(ego.s);

    // The tactical path is sampled at station, so the free-air geometry is
    // retained between and beyond the small regions that need body clearance.
    const topo = topologyResult || obs.topology || null;
    let targetQ = here.q;
    if (topo?.targetQAt) targetQ = topo.targetQAt(ego.s);

    // Dynamic tyre grip scaling from physical tyre telemetry (temperature & wear)
    const tyreScale = this.computeTyreScale(ego);
    const tyreGrip = this.tyreGrip ?? (tyreScale * tyreScale);
    const effSpeedScale = this.speedScale * tyreScale;
    const effLatMax = (vVal) => this.latMax(vVal) * tyreGrip;

    // ---- 1. Multi-Stage Predictive Braking Horizon ----
    const L_brake = Math.max(140.0, v * 3.6);
    const HORIZON_STEPS = this.HORIZON_STEPS;
    const ds_step = L_brake / HORIZON_STEPS;

    const sPred = this.sPred;
    const vRefH = this.vRefH;
    const brkH = this.brkH;
    const dsH = this.dsH;
    const vAllow = this.vAllow;

    let s = ego.s;

    for (let k = 0; k <= HORIZON_STEPS; k++) {
      const smp = this.sample(s, this._horizonSample);
      sPred[k] = s;
      const absKappa = Math.abs(smp.kappa);
      const baseGripMargin = absKappa > 0.010 ? this.gripMarginTight : (absKappa > 0.004 ? this.gripMarginMid : this.gripMarginOpen);
      const gripMargin = baseGripMargin;
      const vGrip = absKappa > 1e-5 ? Math.sqrt(effLatMax(smp.v) / absKappa) * gripMargin : 75.0;

      const normS = ((s % this.ref.length) + this.ref.length) % this.ref.length;
      const smpIdx = Math.round(normS / this.ds) % this.n;
      const isWestLoopApproach = (normS >= 1950 && normS <= 2160) && absKappa < 0.0095;
      const isSmpStraight = absKappa < 0.0035 || ((normS <= 720 || normS >= 2670) && absKappa < 0.005) || isWestLoopApproach;
      const isWestLoopSweeper = normS >= 1950 && normS <= 2170 && absKappa < 0.010;
      const isGentleSweeper = absKappa < 0.0095 || isWestLoopSweeper;
      const isTightCorner = absKappa > 0.020;
      let vLimit;
      if (isSmpStraight) {
        // High-speed straightaway: unconstrained top speed ceiling
        vLimit = 75.0;
      } else if (isGentleSweeper) {
        // Open gentle sweeper: track physical tyre grip envelope rather than false conservative reference profile
        vLimit = Math.max(smp.v * effSpeedScale, Math.min(75.0, vGrip));
      } else if (isTightCorner) {
        // Tight hairpin: track full reference pace and grip envelope
        vLimit = Math.max(1, Math.min(smp.v * effSpeedScale, vGrip * 0.98));
      } else {
        // Genuine corner or chicane: adhere strictly to apex pace and grip envelope
        vLimit = Math.max(1, Math.min(smp.v * effSpeedScale, vGrip));
      }
      vRefH[k] = vLimit;

      if (k < HORIZON_STEPS) {
        const effKappa = isSmpStraight ? 0 : absKappa;
        const uy = effKappa > 0 ? (vLimit * vLimit * effKappa) / Math.max(1e-6, effLatMax(vLimit)) : 0;
        // Strict friction ellipse for tyre braking with trail-brake stability margin
        const frac = uy >= 1.0 ? 0.0 : Math.sqrt(Math.max(0.0, 1.0 - uy * uy));
        const trailFrac = uy > 0.25 ? Math.pow(frac, 1.5) : frac;
        const coastDecel = Math.min(2.0, 0.4 + 0.03 * vLimit);
        // Calibrated tyre brake capacity with configurable safety margin
        brkH[k] = coastDecel + this.brakeMax(vLimit) * tyreGrip * trailFrac * this.brakeMargin;
        dsH[k] = ds_step;
        s += ds_step;
      }
    }

    vAllow[HORIZON_STEPS] = vRefH[HORIZON_STEPS];
    for (let k = HORIZON_STEPS - 1; k >= 0; k--) {
      vAllow[k] = Math.min(vRefH[k], Math.sqrt(Math.max(1, vAllow[k + 1] * vAllow[k + 1] + 2 * brkH[k] * dsH[k])));
    }

    const spec = ego.spec ?? {};
    const normEgoS = ((ego.s % this.ref.length) + this.ref.length) % this.ref.length;
    const frontAxleS = ego.s + (spec.wheelbase ? spec.wheelbase * 0.75 : 2.0);
    const frontSample = this.sample(frontAxleS);
    const absHereKappa = Math.max(Math.abs(here.kappa), Math.abs(frontSample.kappa));
    const baseHereMargin = absHereKappa > 0.010 ? this.gripMarginTight : (absHereKappa > 0.004 ? this.gripMarginMid : this.gripMarginOpen);
    const hereGripMargin = baseHereMargin;
    const isMainStraight = (normEgoS <= 720 || normEgoS >= 2670) && absHereKappa < 0.005;
    const isWestLoopApproach = normEgoS >= 1950 && normEgoS <= 2160 && absHereKappa < 0.0095;
    const isHighSpeedZone = isMainStraight || isWestLoopApproach || absHereKappa < 0.0040;
    const isFlatStraight = absHereKappa < 0.0025;
    const hereGrip = isFlatStraight ? 75.0 : (absHereKappa > 1e-5 ? Math.sqrt(effLatMax(here.v) / absHereKappa) * hereGripMargin : 75.0);
    const isHereStraight = isHighSpeedZone;

    const aheadDist = Math.max(12.0, v * 0.65);
    const ahead = this.sample(ego.s + aheadDist);
    const absAheadKappa = Math.abs(ahead.kappa);
    const aheadMargin = absAheadKappa > 0.010 ? this.gripMarginTight : (absAheadKappa > 0.004 ? this.gripMarginMid : this.gripMarginOpen);
    const aheadGrip = absAheadKappa > 1e-5 ? Math.sqrt(effLatMax(ahead.v) / absAheadKappa) * aheadMargin : 75.0;
    const vAhead = Math.min(ahead.v * effSpeedScale, aheadGrip);

    const kNear = Math.min(HORIZON_STEPS, Math.max(1, Math.ceil(aheadDist / ds_step)));
    let minNearRef = vRefH[0];
    for (let k = 1; k <= kNear; k++) {
      if (vRefH[k] < minNearRef) minNearRef = vRefH[k];
    }

    let vTarget;
    let isSpeedOverriddenUpward = false;
    if (isHighSpeedZone) {
      // On straights and high-speed links: target is the braking horizon velocity boundary (full rollout)
      vTarget = vAllow[0];
      if (vTarget > here.v * effSpeedScale + 0.5) {
        isSpeedOverriddenUpward = true;
      }
    } else {
      // In cornering zones: track physical cornering envelope and smooth reference speed profile
      const vRefNominal = here.v * effSpeedScale;
      // Allow exit rollout if downstream reference is accelerating and not tightening
      const isCornerOpening = (ahead.v >= here.v - 0.2 && absAheadKappa <= absHereKappa - 0.001) || absAheadKappa < 0.005;
      const isExit = isCornerOpening && absHereKappa < 0.016;
      const isGentleCurve = absHereKappa < 0.0095 && absAheadKappa < 0.010;
      let cornerTarget = isGentleCurve
        ? Math.min(hereGrip, aheadGrip * 1.08)
        : Math.min(hereGrip, Math.max(hereGrip * 0.98, vRefNominal));

      // Section 4: Physical Path Curvature for Candidate Feasibility
      // Rather than distance from solo reference line, evaluate against the selected candidate path!
      const isTacticalPath = topo?.targetQAt && topo.activeTopology !== 'FREE_AIR';
      const plannedQ = isTacticalPath ? topo.targetQAt(ego.s) : here.q;
      const latErrorCandidate = Math.abs(egoQVal - plannedQ);

      let effCornerKappa = absHereKappa;
      if (isTacticalPath) {
        const candidateKappa = this.computeCandidateCurvature(ego.s, topo.targetQAt);
        if (candidateKappa !== null && Number.isFinite(candidateKappa)) {
          effCornerKappa = candidateKappa;
          const candidateGripSpeed = effCornerKappa > 1e-4
            ? Math.sqrt(effLatMax(here.v) / effCornerKappa) * hereGripMargin
            : 75.0;
          cornerTarget = Math.min(cornerTarget, candidateGripSpeed);
        }
      }

      // Only derate if vehicle is genuinely failing to track its chosen path (latErrorCandidate > 1.2m)
      if (!this.disableOfflineDerating && effCornerKappa > 0.012 && latErrorCandidate > 1.2) {
        const offlineGrip = Math.sqrt(effLatMax(here.v) / effCornerKappa) * 0.94;
        cornerTarget = Math.min(cornerTarget, offlineGrip);
        const offlineTrim = clamp(1.0 - (latErrorCandidate - 1.2) * 0.08, 0.82, 1.0);
        cornerTarget *= offlineTrim;
      }
      vTarget = Math.max(1, Math.min(cornerTarget, vAllow[0]));
    }
    const freeAirTargetSpeed = vTarget;
    if (topo && Number.isFinite(topo.targetSpeedCap)) {
      vTarget = Math.min(vTarget, topo.targetSpeedCap);
    }
    const trafficLimited = vTarget < freeAirTargetSpeed - 0.1;

    // ---- 2. Coupled Transient Dynamics & Friction Ellipse ----
    const lock = spec.steeringLock ?? this.maxSteer;
    const effHereKappa = absHereKappa;
    const actualLatAccel = Math.abs(v * (ego.yawRate ?? 0));
    const u_y_actual = Math.min(0.95, actualLatAccel / Math.max(1e-6, effLatMax(v)));
    const u_y = effHereKappa > 0 ? (v * v * effHereKappa) / Math.max(1e-6, effLatMax(v)) : 0;
    // For braking budget: use actual lateral acceleration so braking into corners is not artificially choked
    const fracBrake = Math.sqrt(Math.max(0.35, 1.0 - u_y_actual * u_y_actual));

    const steerFraction = lock > 0 ? Math.min(1.0, Math.abs(this.lastSteer) / lock) : 0;
    const effLatDemand = Math.max(u_y_actual, steerFraction * 0.70);
    const fracNow = effLatDemand >= 1.0 ? 0.0 : Math.sqrt(Math.max(0.0, 1.0 - effLatDemand * effLatDemand));

    // Axle-specific RWD grip: rear axle carries 53% normal load and ~47% of lateral acceleration
    const rearLatRatio = 0.887; // 0.47 / 0.53
    const u_y_rear = Math.min(0.95, u_y_actual * rearLatRatio);
    const fracNowRear = u_y_rear >= 1.0 ? 0.0 : Math.sqrt(Math.max(0.0, 1.0 - u_y_rear * u_y_rear));

    const coastDecel = Math.min(2.0, 0.4 + 0.03 * v);
    const budgetDrive = this.driveMax(v) * fracNowRear * this.driveBudgetMargin * tyreGrip;
    const maxBrakeAvailable = this.brakeMax(v) * tyreGrip;
    const budgetBrake = coastDecel + maxBrakeAvailable * fracBrake * this.brakeBudgetMargin;
    const aBrakeNominal = Math.max(3.5, maxBrakeAvailable * this.brakeNominalFactor * fracBrake);

    // Scan horizon for the most binding braking requirement:
    // Evaluate braking margin across all horizon steps rather than terminating early on local inflections
    let bindingIdx = -1;
    let bindingSpeed = v;
    let bindingStation = sPred[HORIZON_STEPS];
    let minBrakingMargin = Infinity;

    for (let k = 1; k <= HORIZON_STEPS; k++) {
      if (vRefH[k] < v - 1.2 && vRefH[k] < 45.0) {
        const deltaSq = Math.max(0, v * v - vRefH[k] * vRefH[k]);
        const reqDist = deltaSq / (2 * aBrakeNominal);
        const rawDist = sPred[k] - ego.s;
        const dist = ((rawDist % this.ref.length) + this.ref.length) % this.ref.length;
        const margin = dist - reqDist;
        if (margin < minBrakingMargin) {
          minBrakingMargin = margin;
          bindingIdx = k;
          bindingSpeed = vRefH[k];
          bindingStation = sPred[k];
        }
      }
    }

    const upcomingCornerSpeed = bindingIdx > 0 ? bindingSpeed : vRefH[HORIZON_STEPS];
    const upcomingCornerStation = bindingIdx > 0 ? bindingStation : sPred[HORIZON_STEPS];
    const upcomingEventId = bindingIdx > 0 ? Math.round(upcomingCornerStation / 30) : 0;

    const rawDistToEvent = upcomingCornerStation - ego.s;
    const distToEvent = ((rawDistToEvent % this.ref.length) + this.ref.length) % this.ref.length;
    const estimatedRequiredBrakingDistance = bindingIdx > 0 ? (Math.max(0, v * v - upcomingCornerSpeed * upcomingCornerSpeed) / (2 * aBrakeNominal)) : 0;
    const brakingMarginMeters = bindingIdx > 0 ? minBrakingMargin : distToEvent;
    const nextBindingStation = upcomingCornerStation;
    const nextBindingTargetSpeed = upcomingCornerSpeed;
    const distToBind = distToEvent;

    let accel = 0;
    let throttle = 0;
    let brake = 0;
    let throttleRequested = 0;
    let brakeRequested = 0;
    let trafficBrakeActive = false;

    if (this.brakeCooldown > 0) this.brakeCooldown--;

    // Section 4 & 5: Physical rear axle traction capacity & predictive feedforward allocation
    let fzRear = 0;
    let fyRear = 0;
    let minRearLoad = 0;
    let maxRearSlip = 0;
    let maxRearSurfTemp = 85;
    let maxRearCoreTemp = 85;

    const wRL = ego.wheels?.[2] || ego.tyres?.[2];
    const wRR = ego.wheels?.[3] || ego.tyres?.[3];

    if (wRL && wRR) {
      const loadRL = wRL.load ?? 0;
      const loadRR = wRR.load ?? 0;
      fzRear = loadRL + loadRR;
      minRearLoad = Math.min(loadRL, loadRR);
      const fyRL = Math.abs(wRL.fy ?? wRL.Fy ?? 0);
      const fyRR = Math.abs(wRR.fy ?? wRR.Fy ?? 0);
      fyRear = fyRL + fyRR;

      const kRL = Math.max(0, wRL.kappa ?? wRL.slipRatio ?? 0);
      const kRR = Math.max(0, wRR.kappa ?? wRR.slipRatio ?? 0);
      maxRearSlip = Math.max(kRL, kRR);

      maxRearSurfTemp = Math.max(wRL.surface ?? 85, wRR.surface ?? 85);
      maxRearCoreTemp = Math.max(wRL.core ?? 85, wRR.core ?? 85);
    } else {
      const tyres = ego.tyres || ego.wheels || [];
      const loads = [];
      for (let i = 2; i <= 3; i++) {
        const t = tyres[i]?.tyre || tyres[i];
        if (!t) continue;
        const l = tyres[i]?.load ?? 0;
        loads.push(l);
        fzRear += l;
        const k = Math.max(0, t.kappa ?? t.slipRatio ?? 0);
        if (k > maxRearSlip) maxRearSlip = k;
        if ((t.surface ?? 85) > maxRearSurfTemp) maxRearSurfTemp = t.surface;
        if ((t.core ?? 85) > maxRearCoreTemp) maxRearCoreTemp = t.core;
      }
      minRearLoad = loads.length >= 2 ? Math.min(loads[0], loads[1]) : fzRear / 2;
    }

    const mass = this.envelope?.mass ?? (spec.mass ? spec.mass + 26 : 1316);
    if (fzRear < 1000) {
      const axEst = Math.max(0, ego.ax ?? 0);
      const longTransfer = (axEst * mass * 0.44) / 2.78;
      fzRear = mass * 9.81 * 0.53 + longTransfer;
      minRearLoad = fzRear / 2;
    }
    if (fyRear < 10) {
      const ayVal = Math.abs(ego.ay ?? 0);
      fyRear = mass * ayVal * 0.47;
    }

    const minGrip = this.tyreTelemetry?.minGripFactor ?? 1.0;
    const avgRearLoadPerTyre = Math.max(100, fzRear / 2);
    const loadFactor = clamp(1 - 0.13 * Math.log(Math.max(0.1, avgRearLoadPerTyre / 3300)), 0.68, 1.18);
    // Plant simulator tyreGrip uses gripFactor(core, pressure) without artificial surface degradation
    const muAvailable = 1.48 * minGrip * loadFactor;

    // Open differential constraint: inside wheel unloads during cornering.
    // Drivetrain differential bias provides 130 N*m cross-coupling (130 / 0.335m = 388 N bias force).
    const diffBiasForce = 388; // 130 Nm / 0.335m radius
    const maxInsideTractionForce = muAvailable * Math.max(100, minRearLoad);
    const maxDiffLimitedFz = minRearLoad > 50
      ? (2 * minRearLoad + (2 * diffBiasForce) / Math.max(0.1, muAvailable))
      : fzRear;
    const effFzRear = Math.min(fzRear, Math.max(minRearLoad * 1.5, maxDiffLimitedFz));

    const maxFyAxle = Math.max(100, muAvailable * fzRear);
    const u_y_axle = clamp(fyRear / maxFyAxle, 0.0, 0.98);
    const uyEff = Math.max(u_y_axle, u_y_rear);
    const tractionScale = Math.sqrt(Math.max(0.04, 1.0 - uyEff * uyEff));

    const fxMaxAvailable = muAvailable * effFzRear * tractionScale;
    const axMaxAvailable = fxMaxAvailable / mass;
    const aDriveEngineMax = Math.max(0.5, this.computeEngineDriveMax(v, ego));
    const throttlePred = clamp(axMaxAvailable / aDriveEngineMax, 0.0, 1.0);

    // Standing start launch throttle cap to prevent 10 Hz clutch/wheelspin chatter at 0-8 m/s
    const launchCap = v < 8.0 ? clamp(0.38 + (v / 8.0) * 0.62, 0.38, 1.0) : 1.0;

    // Thermal-aware slip adaptation (lambdaThermal)
    const thermalStress = Math.max(0, (maxRearCoreTemp - 98.0) / 25.0, (maxRearSurfTemp - 128.0) / 25.0);
    const lambdaThermal = clamp(thermalStress, 0.0, 1.0);

    // Physical dynamic target slip kappa*(uy, thermal)
    const baseTargetSlip = 0.095 * Math.sqrt(Math.max(0.04, 1.0 - uyEff * uyEff));
    const targetSlip = clamp(baseTargetSlip * (1.0 - 0.20 * lambdaThermal), 0.030, 0.095);

    // Closed-loop traction regulation with asymmetric damping
    const slipExcess = maxRearSlip - targetSlip;
    let rawTractionRegulation = 1.0;
    if (slipExcess > 0.0) {
      rawTractionRegulation = clamp(1.0 - slipExcess * 8.0, 0.35, 1.0);
    }
    const filterRate = rawTractionRegulation < this.tractionRegulation ? 35.0 : 12.0;
    this.tractionRegulation = clamp(
      this.tractionRegulation + (rawTractionRegulation - this.tractionRegulation) * clamp(filterRate * dtSafe, 0.0, 1.0),
      0.35,
      1.0
    );
    const tractionRegulation = this.tractionRegulation;

    // Decisive discrete braking state machine with event locking
    if (!this.isBraking) {
      const brakeBuffer = Math.max(2.5, v * 0.08);
      const dpTrigger = (v >= vAllow[0]) && (bindingIdx > 0 && distToEvent > 2.0);
      const marginTrigger = brakingMarginMeters <= brakeBuffer || dpTrigger;
      const needBrake = bindingIdx > 0 &&
        upcomingCornerSpeed < v - 1.2 &&
        distToEvent > 2.5 &&
        marginTrigger &&
        this.brakeCooldown <= 0;
      if (needBrake) {
        this.isBraking = true;
        this.activeBrakingEventId = upcomingEventId;
        this.brakingTargetSpeed = upcomingCornerSpeed;
        this.brakingStation = upcomingCornerStation;
        this.brakingPhase = 'BRAKE_ATTACK';
      }
    } else {
      // Locked to current event: release when corner entry speed is achieved OR apex passed
      const reachedCornerSpeed = v <= this.brakingTargetSpeed + 0.8;
      const rawDistToApex = this.brakingStation - ego.s;
      const distToApex = ((rawDistToApex % this.ref.length) + this.ref.length) % this.ref.length;
      const passedApex = distToApex > this.ref.length - 35.0;
      const shouldRelease = reachedCornerSpeed || (passedApex && v <= this.brakingTargetSpeed + 2.5) || (distToApex > this.ref.length - 50.0);
      if (shouldRelease) {
        this.isBraking = false;
        this.activeBrakingEventId = null;
        this.brakingPhase = 'EXIT_POWER';
        this.brakeCooldown = 15; // ~0.12s deadband to eliminate limit cycle chatter
      }
    }

    if (this.isBraking) {
      // Decisive threshold braking down to corner apex: firm pedal on straight, smooth trail into turn
      const dpDecel = Number.isFinite(brkH[0]) ? brkH[0] : 14.0;
      const speedExcess = Math.max(0, v - this.brakingTargetSpeed);
      const steerFracNow = lock > 0 ? Math.min(1.0, Math.abs(this.lastSteer) / lock) : 0;
      const effLatFactor = clamp(Math.max(u_y, u_y_actual, steerFracNow * 0.85) * 0.85, 0, 0.95);
      const brakeTrailScale = Math.sqrt(Math.max(0.15, 1.0 - effLatFactor * effLatFactor));

      if (speedExcess > 2.0) {
        this.brakingPhase = 'BRAKE_ATTACK';
        const reqDecel = dpDecel + speedExcess * 2.0;
        accel = -clamp(reqDecel, 4.0, budgetBrake);
        const minBrakeFloor = steerFracNow > 0.25 ? 0.0 : 0.45;
        const rawBrake = clamp((-accel - coastDecel) / Math.max(1e-6, maxBrakeAvailable), minBrakeFloor, 1.0);
        brake = rawBrake * brakeTrailScale;
      } else {
        this.brakingPhase = 'BRAKE_TRAIL';
        const trailRatio = clamp(speedExcess / 2.0, 0.0, 0.70);
        brake = trailRatio * brakeTrailScale;
        accel = -brake * maxBrakeAvailable;
      }
      // Slide & rear saturation brake relief: prevents unloaded rear axle snap spin
      const absBeta = Math.abs(carBeta);
      if (brake > 0 && absBeta > 0.08) {
        brake *= clamp(1.0 - (absBeta - 0.08) * 8.0, 0.0, 1.0);
        accel = -brake * maxBrakeAvailable;
      }

      // Rear axle ABS / braking slip regulation:
      // Due to forward load transfer under heavy deceleration, 58/42 brake bias
      // overdrives the lightly-loaded rear axle, causing severe lockup (kappa < -0.16)
      // and extreme thermal scrubbing. Peak braking traction is at kappa ~ -0.075 to -0.090.
      if (brake > 0.12) {
        const rTyres = ego.wheels ? ego.wheels.map(w => w.tyre || w) : (ego.tyres || []);
        if (rTyres.length >= 4) {
          const minRearKappa = Math.min(rTyres[2]?.kappa ?? 0, rTyres[3]?.kappa ?? 0);
          if (minRearKappa < -0.075) {
            const relief = clamp(1.0 + (minRearKappa + 0.075) * 6.0, 0.50, 1.0);
            brake *= relief;
            accel = -brake * maxBrakeAvailable;
          }
        }
      }
      brakeRequested = brake;
      throttle = 0;
      throttleRequested = 0;
    } else if (isFlatStraight && (!topo || !Number.isFinite(topo.targetSpeedCap) || v < topo.targetSpeedCap - 0.5)) {
      // On flat straights: progressive launch cap and closed-loop traction regulation
      throttleRequested = 1.0;
      throttle = 1.0 * launchCap * tractionRegulation;
      accel = throttle * budgetDrive;
      brake = 0;
      brakeRequested = 0;
    } else {
      // In corners or transitions: physical feedforward drag & rolling resistance compensation + closed-loop trim
      const a_ff = coastDecel;
      const speedDeficit = vTarget - v;
      const isExit = (ahead.v >= here.v - 0.2) && (absAheadKappa <= absHereKappa + 0.001) && (absHereKappa < 0.016) && (v <= vTarget + 0.5);
      const driveFrac = fracNowRear * tyreScale;

      // Controlled slip model:
      let betaDamp = 1.0;
      if (absBeta > 0.08 || (absBeta > 0.040 && betaDiverging)) {
        betaDamp = clamp(1.0 - (absBeta - 0.040) * 12.0, 0.15, 1.0);
      }

      // Lateral track velocity and predictive forward body rollout
      const headingErr = angle(ego.yaw - here.heading);
      const vLatTrack = v * Math.sin(headingErr + carBeta);
      const egoQVal = Number.isFinite(ego.q) ? ego.q : (Number.isFinite(ego.lateral) ? ego.lateral : 0);
      const qPred = egoQVal + vLatTrack * 0.35;
      const isDriftingOut = (egoQVal * (vLatTrack || 0)) > 0.05 && Math.abs(qPred) > Math.abs(egoQVal);
      const roadHalfWidth = this.ref?.halfWidth || 8.2;
      const boundThreshold = Math.max(6.45, roadHalfWidth - 1.4);
      const isApproachingWall = (Math.abs(egoQVal) > boundThreshold && isDriftingOut) || Math.abs(egoQVal) > roadHalfWidth - 0.7;
      const boundaryDamp = (v > 10.0 && isApproachingWall)
        ? clamp(1.0 - (Math.max(Math.abs(qPred), Math.abs(egoQVal)) - boundThreshold) * 3.5, 0.0, 1.0)
        : 1.0;

      const hasBoundaryMargin = Math.abs(egoQVal) < 4.5 && Math.abs(qPred) < 5.0;

      if (topo && Number.isFinite(topo.targetSpeedCap) && v > topo.targetSpeedCap + 0.5) {
        // Traffic speed governor active: trailing behind rival
        const excess = v - topo.targetSpeedCap;
        const decelReq = clamp(excess * 0.65 / Math.max(1, maxBrakeAvailable), 0, 0.75);
        brake = decelReq;
        brakeRequested = decelReq;
        accel = -brake * maxBrakeAvailable;
        throttle = 0;
        throttleRequested = 0;
        trafficBrakeActive = true;
      } else if (isExit && this.cornerExitAggression > 0 && (!topo || !Number.isFinite(topo.targetSpeedCap) || v < topo.targetSpeedCap - 0.5)) {
        // Confident corner exit rollout when track unwinds: allocate transmissible forward drive
        const rawDemand = clamp(0.95 + Math.max(0, speedDeficit) * 0.20, 0.75, 1.0);
        const demand = Math.min(rawDemand, throttlePred);
        throttleRequested = rawDemand;
        const minExitFloor = hasBoundaryMargin && uyEff < 0.70 && absBeta < 0.035 ? 0.12 : 0.0;
        throttle = clamp(demand * betaDamp * boundaryDamp * tractionRegulation * launchCap, minExitFloor, 1.0);
        accel = throttle * budgetDrive;
        brake = 0;
        brakeRequested = 0;
      } else if (speedDeficit > 0.05) {
        // Positive acceleration / speed build demand bounded by predictive traction capacity
        const a_fb = clamp(speedDeficit * this.throttleGain, -2.0, 8.0);
        const a_cmd = a_ff + a_fb;
        const rawDemand = clamp(a_cmd / aDriveEngineMax, 0.15, 1.0);
        const demand = Math.min(rawDemand, throttlePred);
        throttleRequested = rawDemand;
        throttle = clamp(demand * betaDamp * boundaryDamp * tractionRegulation * launchCap, 0, 1);
        accel = throttle * budgetDrive;
        brake = 0;
        brakeRequested = 0;
      } else if (speedDeficit < -2.2 && v > 12.0) {
        // Actual overspeed: vehicle carries excess kinetic energy beyond cornering target
        const excess = -speedDeficit;
        const decelReq = clamp((excess - 1.2) * 0.40 / Math.max(1, maxBrakeAvailable), 0.04, 0.55);
        brake = decelReq * fracBrake;
        brakeRequested = decelReq;
        accel = -brake * maxBrakeAvailable;
        throttle = 0;
        throttleRequested = 0;
        this.state.brakeReason = BRAKE_REASON.ACTUAL_OVERSPEED;
      } else {
        // In-turn maintenance: roll off throttle smoothly, NO BRAKES mid-corner for small deficits!
        const blend = clamp((speedDeficit + 1.0) / 1.0, 0.0, 1.0);
        const cornerMaintLimit = absHereKappa > 0.018 ? 0.20 : this.cornerMaintMax;
        const maintDemand = clamp(a_ff / aDriveEngineMax, 0.0, cornerMaintLimit);
        const demand = blend * maintDemand;
        throttleRequested = demand;
        // Maintain neutral throttle (0.022) to cancel engine drag torque when rolling in-turn
        const coastNeutralFloor = (v > 15.0 && hasBoundaryMargin) ? 0.022 : 0.0;
        const maintFloor = speedDeficit < -0.5 ? coastNeutralFloor : (hasBoundaryMargin && absBeta < 0.035 ? 0.035 : coastNeutralFloor);
        throttle = clamp(demand * Math.min(1.0, fracNowRear * 1.5) * betaDamp * boundaryDamp * tractionRegulation, maintFloor, cornerMaintLimit);
        accel = throttle * budgetDrive;
        brake = 0;
        brakeRequested = 0;
      }
    }

    // Traction guard: intervene only if vehicle is actually diverging / spinning
    const unstable = this.isUnstable(ego, v, here.kappa, carBeta);
    if (unstable) {
      if (v > 12) {
        throttle = 0;
        accel = Math.min(accel, -0.5);
      } else {
        // At low speed, maintain drive to power out of launch/spin rather than stalling
        throttle = Math.min(throttle, 0.40);
        accel = throttle * budgetDrive;
      }
    }

    // ---- 3. Coupled Lateral Steering ----
    const wheelbase = spec.wheelbase ?? this.wheelbase;

    // Adaptive lookahead tracking chosen continuation or tactical corridor
    const egoQ = Number.isFinite(ego.q) ? ego.q : (Number.isFinite(ego.lateral) ? ego.lateral : 0);
    const look = clamp(this.lookaheadGain * v, this.lookaheadMin, this.lookaheadMax);
    const target = this.sample(ego.s + look);
    
    let targetX = target.x;
    let targetZ = target.z;

    let targetLateral = target.q;
    if (topo?.targetQAt && topo.activeTopology !== 'FREE_AIR') {
      const roadLimit = (this.ref?.halfWidth || 8.2) - 1.2;
      targetLateral = clamp(topo.targetQAt(ego.s + look), -roadLimit, roadLimit);
    }
    const desiredTacticalOffset = targetLateral - target.q;

    if (!Number.isFinite(this.trackedTacticalOffset)) {
      this.trackedTacticalOffset = desiredTacticalOffset;
    }

    // Rate-limit tactical offset transitions to prevent violent lane-change snaps
    // Under high cornering demand, lateral transitions are smoothed to protect tyre grip
    const latGripHeadroom = clamp(1.0 - (u_y_actual - 0.45) * 1.5, 0.45, 1.0);
    const maxLatRate = Math.min(2.8, Math.max(1.5, 0.07 * v)) * latGripHeadroom;
    const maxShift = maxLatRate * dt;
    this.trackedTacticalOffset = clamp(desiredTacticalOffset,
      this.trackedTacticalOffset - maxShift,
      this.trackedTacticalOffset + maxShift);

    const qOffset = this.trackedTacticalOffset;
    if (Math.abs(qOffset) > 1e-4) {
      const nx = Math.cos(target.heading);
      const nz = -Math.sin(target.heading);
      targetX += qOffset * nx;
      targetZ += qOffset * nz;
    }

    const dx = targetX - ego.x, dz = targetZ - ego.z;
    const travelled = Math.max(3, Math.hypot(dx, dz));
    const alpha = angle(Math.atan2(dx, dz) - ego.yaw);
    const pp = Math.atan2(2 * wheelbase * Math.sin(alpha), travelled);

    const ff = this.steerFeedforward * Math.atan(wheelbase * target.kappa);
    const effUndersteerCoeff = this.understeerCoeff / Math.max(0.6, tyreScale);
    const understeer = effUndersteerCoeff * v * v * here.kappa;

    // Contact patch slip angles & active oversteer countersteering
    const safeV = Math.max(3.0, v);
    const alphaPeak = 0.140;
    let alphaR = 0;
    let alphaF = 0;
    const tyres = ego.wheels || ego.tyres || [];
    if (tyres.length >= 4) {
      const aFL = Math.abs(tyres[0]?.alpha ?? tyres[0]?.slipAngle ?? 0);
      const aFR = Math.abs(tyres[1]?.alpha ?? tyres[1]?.slipAngle ?? 0);
      const aRL = Math.abs(tyres[2]?.alpha ?? tyres[2]?.slipAngle ?? 0);
      const aRR = Math.abs(tyres[3]?.alpha ?? tyres[3]?.slipAngle ?? 0);
      alphaF = Math.max(aFL, aFR);
      alphaR = Math.max(aRL, aRR);
    }
    if (alphaR < 1e-4 && alphaF < 1e-4) {
      const b = wheelbase * 0.53;
      const a = wheelbase * 0.47;
      alphaR = Math.abs(carBeta - (b * (ego.yawRate ?? 0)) / safeV);
      alphaF = Math.abs(this.lastSteer * lock - carBeta - (a * (ego.yawRate ?? 0)) / safeV);
    }
    const satR = alphaR / alphaPeak;
    const satF = alphaF / alphaPeak;
    // Physical oversteer discriminator:
    // Requires rear axle saturation beyond peak grip (satR > 1.05), OR
    // severe rear saturation exceeding front saturation while body slip actively diverges (|beta| > 0.10)
    const isOversteering = satR > 1.05 || (satR > 0.90 && satR > satF && betaDiverging && absBeta > 0.10);
    const giveUp = isOversteering ? clamp((Math.max(absBeta / 0.15, satR) - 1.0) / 0.50, 0, 1) : 0;
    const hold = isOversteering ? clamp(1.0 - (absBeta > 0.10 ? (absBeta - 0.10) * 8.0 : 0.0), 0.15, 1.0) : 1.0;

    const rDes = (target.kappa + (2 * Math.sin(alpha) / travelled)) * v;
    const eYaw = rDes - (ego.yawRate ?? 0);
    const kYaw = isOversteering ? 0.20 : 0.10;
    // Omnidirectional yaw damping: preserves critical stabilizing rate damping across full road width
    let damp = clamp(kYaw * eYaw, -0.22, 0.22);

    const returningRate = (ego.yawRate ?? 0) * carBeta;
    const snapDamp = (isOversteering && returningRate > 0.05)
      ? clamp(1.0 - (returningRate - 0.05) * 1.5, 0.25, 1.0)
      : 1.0;
    const betaExcess = isOversteering ? (carBeta > 0.08 ? carBeta - 0.08 : (carBeta < -0.08 ? carBeta + 0.08 : 0)) : 0;
    const kBeta = 1.35 * (1.0 + 1.5 * giveUp) * snapDamp;

    // Lateral track velocity and predictive boundary return assist
    const headingErr = angle(ego.yaw - here.heading);
    const vLatTrack = v * Math.sin(headingErr + carBeta);
    let boundarySteerCorrection = 0;
    const absEgoQ = Math.abs(egoQ);
    const roadHalfWidth = this.ref?.halfWidth || 8.2;
    const steerThreshold = Math.max(6.85, roadHalfWidth - 1.35);
    if (!isOversteering && absEgoQ > steerThreshold) {
      const excess = absEgoQ - steerThreshold;
      const sign = Math.sign(egoQ);
      // Continuous boundary assist: proportional to edge proximity, gently guided without bang-bang discontinuities
      const outwardFactor = egoQ * (vLatTrack || 0) > 0 ? 1.0 : 0.4;
      boundarySteerCorrection = -sign * clamp(excess * 0.35 * outwardFactor, 0, 0.15);
    }

    // Front-axle tyre saturation guard: limits steering angle at high speeds to prevent plowing/scrub
    const maxGripSteerAngle = alphaPeak * 1.35 + (wheelbase * 0.55 * Math.abs(ego.yawRate ?? 0)) / safeV;
    const steerAngleLimit = Math.min(lock, Math.max(0.25, maxGripSteerAngle));

    let steerRaw = (pp + ff) * hold + understeer + damp + (kBeta * betaExcess) + boundarySteerCorrection;
    const effSteerLimit = isOversteering ? lock : steerAngleLimit;
    steerRaw = clamp(steerRaw, -effSteerLimit, effSteerLimit);
    let steer = clamp(steerRaw / lock, -1, 1);
    const maxStep = (this.steerRate / lock) * dt;
    steer = this.lastSteer + clamp(steer - this.lastSteer, -maxStep, maxStep);
    steer = clamp(steer, -1, 1);
    this.lastSteer = steer;

    this.state.isOversteering = isOversteering;
    this.state.debugSteer = { pp, ff, hold, understeer, damp, betaExcess, boundarySteerCorrection, steerRaw, steer, isOversteering, satR, satF };

    // Determine limit reasons
    let targetLimitReason = TARGET_LIMIT_REASON.NONE;
    if (trafficLimited) {
      targetLimitReason = TARGET_LIMIT_REASON.TRAFFIC;
    } else if (tyreScale < 0.96 && hereGrip < 72.0) {
      targetLimitReason = TARGET_LIMIT_REASON.TYRE_STATE;
    } else if (vTarget >= 74.0) {
      targetLimitReason = TARGET_LIMIT_REASON.NONE;
    } else if (vTarget === vAllow[0] && vAllow[0] < (here.v * this.speedScale) - 0.5) {
      targetLimitReason = TARGET_LIMIT_REASON.BRAKING_ENVELOPE;
    } else if (hereGrip <= (here.v * this.speedScale) + 0.1 && hereGrip < 70.0) {
      targetLimitReason = TARGET_LIMIT_REASON.GRIP_LIMIT;
    } else if (this.speedScale < 0.999) {
      targetLimitReason = TARGET_LIMIT_REASON.SPEED_SCALE;
    } else {
      targetLimitReason = TARGET_LIMIT_REASON.REFERENCE_PROFILE;
    }

    let brakeReason = BRAKE_REASON.NONE;
    if (this.isBraking || brake > 0) {
      if (trafficBrakeActive) {
        brakeReason = BRAKE_REASON.TRAFFIC;
      } else if (v > vAllow[0] + 0.15) {
        brakeReason = BRAKE_REASON.UPCOMING_SPEED_CONSTRAINT;
      } else if (v > vTarget + 0.5) {
        brakeReason = BRAKE_REASON.ACTUAL_OVERSPEED;
      } else if (unstable) {
        brakeReason = BRAKE_REASON.STABILITY;
      } else {
        brakeReason = BRAKE_REASON.UPCOMING_SPEED_CONSTRAINT;
      }
    }

    let throttleLimitReason = THROTTLE_LIMIT_REASON.NONE;
    if (trafficBrakeActive) {
      throttleLimitReason = THROTTLE_LIMIT_REASON.TRAFFIC;
    } else if (this.isBraking || brake > 0) {
      throttleLimitReason = THROTTLE_LIMIT_REASON.UPCOMING_BRAKING;
    } else if (throttle >= 0.95) {
      throttleLimitReason = THROTTLE_LIMIT_REASON.NONE;
    } else if (unstable) {
      throttleLimitReason = THROTTLE_LIMIT_REASON.YAW_STABILITY;
    } else if (fracNow < 0.85) {
      throttleLimitReason = THROTTLE_LIMIT_REASON.COMBINED_GRIP;
    } else if (Math.abs(vTarget - v) <= 0.3) {
      throttleLimitReason = THROTTLE_LIMIT_REASON.TARGET_REACHED;
    } else if (isHereStraight) {
      throttleLimitReason = THROTTLE_LIMIT_REASON.NONE;
    } else {
      throttleLimitReason = THROTTLE_LIMIT_REASON.COMBINED_GRIP;
    }

    const isHeadingAligned = Math.abs(headingErr) < 0.15;
    const isBetaStable = Math.abs(carBeta) < 0.08;
    const isYawRateStable = Math.abs(ego.yawRate ?? 0) < 0.40;
    const isLatClear = u_y < 0.35;
    const isBrakingFar = brakingMarginMeters > 15.0;
    const isClearFullThrottleEligible =
      isHereStraight &&
      absHereKappa < 0.0035 &&
      isHeadingAligned &&
      isBetaStable &&
      isYawRateStable &&
      isLatClear &&
      isBrakingFar &&
      !this.isBraking;

    let cornerPhase = 'STRAIGHT';
    if (this.isBraking || brake > 0) {
      cornerPhase = 'BRAKING';
    } else if (isHereStraight) {
      cornerPhase = 'STRAIGHT';
    } else {
      if (Math.abs(here.kappa) >= Math.abs(ahead.kappa) && Math.abs(here.kappa) > 0.008) {
        cornerPhase = 'APEX';
      } else if (Math.abs(ahead.kappa) > Math.abs(here.kappa)) {
        cornerPhase = 'ENTRY';
      } else {
        cornerPhase = 'EXIT';
      }
    }

    // Comprehensive Longitudinal Causal Trace State
    this.state.t = +(obs.time ?? 0).toFixed(3);
    this.state.s = +ego.s.toFixed(2);
    this.state.sector = here.i;
    this.state.cornerPhase = cornerPhase;

    this.state.speed = v;
    this.state.vx = ego.vx ?? (v * Math.cos(ego.yaw ?? 0));
    this.state.vy = ego.vy ?? (v * Math.sin(ego.yaw ?? 0));
    this.state.beta = ego.beta ?? 0;
    this.state.yawRate = ego.yawRate ?? 0;
    this.state.q = egoQ;
    this.state.headingError = headingErr;
    this.state.steer = steer;

    this.state.refSpeedHere = here.v;
    this.state.refSpeedAhead = ahead.v;
    this.state.refQ = here.q;
    this.state.refKappa = here.kappa;
    this.state.refHeading = here.heading;

    this.state.speedScale = this.speedScale;
    this.state.tyreScale = tyreScale;
    this.state.tyreTelemetry = this.tyreTelemetry ?? null;
    this.state.minGripFactor = this.tyreTelemetry?.minGripFactor ?? 1.0;
    this.state.maxWear = this.tyreTelemetry?.maxWear ?? 0.0;
    this.state.targetLimitReason = targetLimitReason;
    this.state.throttleLimitReason = throttleLimitReason;
    this.state.brakeReason = brakeReason;
    this.state.vReferenceScaled = here.v * this.speedScale;
    this.state.vGrip = hereGrip;
    this.state.vAhead = vAhead;
    this.state.vAllow0 = vAllow[0];
    this.state.vTarget = vTarget;

    this.state.driveMaxRaw = this.driveMax(v);
    this.state.brakeMaxRaw = maxBrakeAvailable;
    this.state.coastDecel = coastDecel;
    this.state.latMax = this.latMax(v);
    this.state.uYRaw = u_y;
    this.state.remainingLongitudinalFraction = fracNow;
    this.state.driveBudget = budgetDrive;
    this.state.brakeBudget = budgetBrake;

    this.state.speedDeficit = vTarget - v;
    this.state.accelRequestedRaw = throttle > 0 ? throttle * budgetDrive : (brake > 0 ? -brake * maxBrakeAvailable : 0);
    this.state.accelAfterLimits = accel;
    this.state.throttleRequested = throttleRequested;
    this.state.throttleApplied = throttle;
    this.state.brakeRequested = brakeRequested;
    this.state.brakeApplied = brake;

    this.state.distanceToNextBindingSpeedConstraint = +distToBind.toFixed(1);
    this.state.nextBindingStation = +nextBindingStation.toFixed(1);
    this.state.nextBindingTargetSpeed = +nextBindingTargetSpeed.toFixed(1);
    this.state.estimatedRequiredBrakingDistance = +estimatedRequiredBrakingDistance.toFixed(1);
    this.state.brakingMarginMeters = +brakingMarginMeters.toFixed(1);

    this.state.frontUtilization = Math.min(1.0, u_y);
    this.state.rearUtilization = Math.min(1.0, Math.hypot(u_y, (budgetDrive > 0 ? Math.max(0, accel) / budgetDrive : 0)));
    this.state.stabilityLimitActive = Boolean(unstable);

    this.state.targetLimitReason = targetLimitReason;
    this.state.throttleLimitReason = throttleLimitReason;
    this.state.brakeReason = brakeReason;
    this.state.clearFullThrottleEligible = isClearFullThrottleEligible;

    // Legacy/compatibility fields
    this.state.targetSpeed = vTarget;
    this.state.horizonSpeed = vAllow[0];
    this.state.accel = accel;
    this.state.uyMax = u_y;
    this.state.brake = brake;
    this.state.throttle = throttle;
    this.state.elat = egoQ - targetQ;
    this.state.ehead = headingErr;
    this.state.mode = 'NOVA_COUPLED';
    this.state.reason = throttleLimitReason !== THROTTLE_LIMIT_REASON.NONE ? throttleLimitReason : (brakeReason !== BRAKE_REASON.NONE ? brakeReason : targetLimitReason);
    this.state.rlat = this.state.elat;
    this.state.rhead = this.state.ehead;
    this.state.pp = pp;
    this.state.ff = 0;
    this.state.damp = damp;
    this.state.kappaRef = here.kappa;
    this.state.requiredAccel = Math.max(0, accel);
    this.state.plannedBrake = this.isBraking || brake > 0;
    this.state.vGrip = effHereKappa > 0 ? Math.sqrt(Math.max(1, this.latMax(v) / effHereKappa)) : 99.0;

    return { steer, throttle, brake, reverse: false };
  }

  isUnstable(ego, v, kappa, carBeta = null) {
    if (v <= 6) return false;
    const absYawRate = Math.abs(ego.yawRate ?? 0);
    if (absYawRate > 1.05) return true;
    const beta = Math.abs(carBeta ?? Math.atan2(ego.v ?? 0, Math.max(0.1, Math.abs(ego.u ?? v))));
    const maxBeta = Math.max(0.15, 3.2 / Math.max(5.0, v));
    if (beta > maxBeta) return true;

    if (!this.enableDynamicStability) {
      return absYawRate > this.yawStabilityThreshold;
    }

    const targetYawRate = v * (kappa ?? 0);
    const yawError = (ego.yawRate ?? 0) - targetYawRate;

    // Dynamic stability: distinguish intentional rotation from divergent yaw
    const isCounterSteering =
      beta > 0.08 &&
      Math.abs(this.lastSteer) > 0.12 &&
      Math.sign(this.lastSteer) !== Math.sign(ego.yawRate ?? 0) &&
      absYawRate > 0.35;

    const isDiverging = Math.abs(yawError) > 0.50 && beta > 0.12;

    return isCounterSteering || isDiverging;
  }

  computeCandidateCurvature(s, targetQAt) {
    if (!this.model?.point || typeof targetQAt !== 'function') return null;
    const ds = 6.0;
    const s0 = s;
    const s1 = s + ds;
    const s2 = s + 2 * ds;
    const q0 = targetQAt(s0);
    const q1 = targetQAt(s1);
    const q2 = targetQAt(s2);
    if (!Number.isFinite(q0) || !Number.isFinite(q1) || !Number.isFinite(q2)) return null;
    const p0 = this.model.point(s0, q0);
    const p1 = this.model.point(s1, q1);
    const p2 = this.model.point(s2, q2);
    return mengerCurvature(p0, p1, p2);
  }

  computeTyreScale(ego) {
    if (!ego) return 1.0;
    const tyres = ego.tyres ?? (ego.wheels ? ego.wheels.map((w) => w.tyre) : null);
    if (!tyres || !tyres.length) return 1.0;
    let minGrip = 1.0;
    let maxWear = 0.0;
    const details = [];
    for (const t of tyres) {
      if (!t) continue;
      const gCore = gripFactor(t.core ?? 85, t.pressure ?? 2.15);
      // Plant simulator tyreGrip does not degrade grip by surface temperature (only core & pressure)
      const g = gCore;
      if (g < minGrip) minGrip = g;
      if ((t.wear ?? 0) > maxWear) maxWear = t.wear;
      details.push({
        core: t.core ?? 85,
        surface: t.surface ?? 85,
        pressure: t.pressure ?? 2.15,
        wear: t.wear ?? 0,
        gripFactor: g
      });
    }
    const gripProduct = Math.max(0.2, minGrip * (1 - maxWear * 0.35));
    // Physical velocity scale is sqrt(grip product) governed by the limiting tyre
    const scale = clamp(Math.sqrt(gripProduct), 0.70, 1.0);
    this.tyreTelemetry = {
      tyreScale: scale,
      minGripFactor: minGrip,
      maxWear,
      tyres: details
    };
    return scale;
  }

  computeEngineDriveMax(v, ego) {
    const gears = [0, 3.05, 2.12, 1.62, 1.29, 1.06, 0.88];
    const finalDrive = 3.8;
    const radius = 0.335;
    const maxTorque = 575;
    const mass = this.envelope?.mass ?? (ego?.spec?.mass ? ego.spec.mass + 26 : 1316);

    let gear = ego?.gear;
    if (!gear || gear < 1 || gear > 6) {
      if (v < 22) gear = 1;
      else if (v < 32) gear = 2;
      else if (v < 42) gear = 3;
      else if (v < 53) gear = 4;
      else if (v < 64) gear = 5;
      else gear = 6;
    }
    const ratio = (gears[gear] ?? 1.0) * finalDrive;
    let rpm = ego?.rpm;
    if (!rpm || rpm < 1000) {
      rpm = clamp(Math.abs(v) / radius * ratio * 9.5493, 1100, 8300);
    }
    const torqueCurve = clamp(1 - ((rpm - 5500) / 6700) ** 2, 0.45, 1);
    const maxDriveTorque = maxTorque * torqueCurve * ratio * 0.91;
    const maxDriveForce = maxDriveTorque / radius;
    return maxDriveForce / mass;
  }

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

export function createCoupledController(config) {
  return new NovaCoupledController(config);
}
