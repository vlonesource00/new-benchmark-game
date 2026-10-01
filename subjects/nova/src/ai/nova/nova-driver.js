import { NovaValueField } from './value-field.js';
import { NovaBeliefEngine } from './belief-occupancy.js';
import { NovaTopologyPlanner } from './topology-planner.js';
import { NovaCoupledController } from './coupled-controller.js';

export class NovaDriver {
  /**
   * Instantiates all NOVA components and wires them into a single Session-compatible driver.
   * Matches the constructor signature expected by Session for NOVAFreeAirController.
   */
  constructor({ reference, envelope, options = {}, fallback = null, model = null, line = null }) {
    this.trackData = reference;
    this.envelope = envelope;
    this.model = model;
    this.options = options;
    this.fallback = fallback;
    this._line = line;
    
    // Wire all NOVA components
    this.valueField = new NovaValueField({ reference, envelope, model });
    this.beliefEngine = new NovaBeliefEngine(options);
    this.topologyPlanner = new NovaTopologyPlanner({ ...options, envelope });
    this.coupledController = new NovaCoupledController({ reference, envelope, options, fallback, model, line });

    this.novaTime = 0;
    this.legacyTime = 0;
    this.fallbackCount = 0;
    this.strictFail = null;
    this.trace = [];

    // Telemetry state expected by Debugger and Session HUD
    this.state = {
      mode: 'NOVA',
      intent: 'init',
      rlat: 0,
      rhead: 0,
      elat: 0,
      ehead: 0,
      targetSpeed: 0,
      horizonSpeed: 0,
      accel: 0,
      brake: 0,
      throttle: 0,
      steer: 0,
      vGrip: 0,
    };
  }

  /**
   * Legacy-shaped read-only view so the lap recorder, debugger and UI can
   * read a line without knowing which controller is driving.
   */
  get line() {
    return this._line || this.coupledController.line || this.coupledController._lineView;
  }

  reset() {
    if (this.coupledController && this.coupledController.reset) this.coupledController.reset();
    this.beliefEngine = new NovaBeliefEngine(this.options);
    this.topologyPlanner = new NovaTopologyPlanner({ ...this.options, envelope: this.envelope });
    this.topologyResult = null;
    
    this.state = {
      mode: 'NOVA',
      intent: 'reset',
      rlat: 0,
      rhead: 0,
      targetSpeed: 0,
      accel: 0,
      brake: 0,
      throttle: 0
    };
  }

  step(obs) {
    if (!obs || !obs.ego) {
      return { steer: 0, throttle: 0, brake: 0, reverse: false };
    }

    const ego = obs.ego;
    // 1. Extract ego state
    const egoState = {
      id: ego.id,
      s: ego.s,
      q: ego.q,
      v: ego.speed || ego.v,
      yaw: ego.yaw,
      yawRate: ego.yawRate,
      tyres: ego.tyres,
      controls: ego.controls,
      x: ego.x,
      y: ego.z || ego.y
    };

    // 2. Update beliefEngine with visible opponents
    const opponents = obs.opponents || obs.rivals || [];
    if (this.beliefEngine && this.beliefEngine.update) {
      this.beliefEngine.update(opponents, ego, obs.dt || (1/120));
    }

    // 3. Evaluate tactical continuations from the free-air reference
    let topologyResult = null;
    let intentName = 'FREE_AIR';
    
    if (this.topologyPlanner && this.topologyPlanner.plan) {
      topologyResult = this.topologyPlanner.plan(
          egoState,
          opponents,
          this.valueField,
          this.beliefEngine,
          this.trackData,
          obs.time || 0,
          obs.dt
      );
      if (topologyResult && topologyResult.activeTopology) {
        intentName = topologyResult.activeTopology;
      }
    }

    const dt = obs.dt || (1/120);
    this.novaTime = (this.novaTime || 0) + dt;

    // Maintain rock-solid forward plan for visual debuggers and telemetry
    const activeLine = this.line;
    if (this.model && activeLine && activeLine.q) {
      const L_plan = Math.max(45, Math.min(110, (ego.speed || 25) * 2.2));
      const nPts = 36;
      const pts = [];
      const px = new Float64Array(nPts);
      const pz = new Float64Array(nPts);
      const vArr = new Float64Array(nPts);
      const s0 = ego.s;
      const q0 = Number.isFinite(ego.q) ? ego.q : (ego.lateral ?? 0);
      
      for (let k = 0; k < nPts; k++) {
        const u = k / (nPts - 1);
        const dist = u * L_plan;
        const sK = s0 + dist;
        // Smooth Hermite blend onto target line over first 18-20m
        const blend = Math.min(1.0, u * 2.4);
        const smoothBlend = blend * blend * (3 - 2 * blend);
        const idx = this.model.index(sK);
        const refQ = activeLine.q[idx] ?? 0;
        const plannedQ = topologyResult?.targetQAt ? topologyResult.targetQAt(sK) : refQ;
        const qK = q0 + (plannedQ - q0) * smoothBlend;
        const pt = this.model.point(sK, qK);
        px[k] = pt.x;
        pz[k] = pt.z;
        const vK = activeLine.profile?.v ? activeLine.profile.v[idx] : (ego.speed || 25);
        vArr[k] = vK;
        pts.push({
          x: pt.x,
          y: 0.15,
          z: pt.z,
          s: sK,
          q: qK,
          speed: vK,
          predictedSpeed: vK,
        });
      }
      this.trajectoryPlan = { points: pts, trackingPoint: pts[Math.min(pts.length - 1, 4)] };
      this.local = { path: { n: nPts, px, pz }, profile: { v: vArr } };
    }

    // 4. Pass selected corridor/target to coupledController
    let controls = { steer: 0, throttle: 0, brake: 0, reverse: false };
    if (this.coupledController && this.coupledController.step) {
      obs.topology = topologyResult; // Attach in case coupledController reads it from obs
      controls = this.coupledController.step(obs, topologyResult);
    }

    // 5. Populate this.state with telemetry
    const ccState = this.coupledController.state || {};
    this.topologyResult = topologyResult;
    const computedTargetQ = topologyResult && Number.isFinite(topologyResult.targetQ)
      ? topologyResult.targetQ
      : (this.line?.q ? (this.line.q[this.model?.index(ego.s) ?? 0] ?? 0) : 0);
    this.targetQ = computedTargetQ;
    
    this.state = {
      ...ccState,
      mode: 'NOVA',
      intent: intentName,
      targetQ: computedTargetQ,
      targetOffset: computedTargetQ,
      rlat: ccState.elat || 0,
      rhead: ccState.ehead || 0,
      elat: ccState.elat || 0,
      ehead: ccState.ehead || 0,
      targetSpeed: ccState.targetSpeed || 0,
      horizonSpeed: ccState.horizonSpeed || 0,
      accel: ccState.accel || 0,
      brake: ccState.brake || controls.brake || 0,
      throttle: ccState.throttle || controls.throttle || 0,
      steer: controls.steer || 0,
      vGrip: ccState.vGrip || 0,
      beta: ego.beta ?? 0,
      yawRateError: ego.yawRate - (ego.speed * (ccState.kappaRef || 0)),
      isThreeWide: Boolean(this.topologyPlanner?.episodeTracker?.isThreeWide),
      threeWideDetails: this.topologyPlanner?.episodeTracker?.threeWideDetails ?? null,
    };

    if (this.trace && Array.isArray(this.trace)) {
      this.trace.push({
        t: +this.novaTime.toFixed(3),
        s: +ego.s.toFixed(2),
        v: +ego.speed.toFixed(2),
        q: +(ego.q ?? ego.lateral ?? 0).toFixed(2),
        targetSpeed: +this.state.targetSpeed.toFixed(2),
        horizonSpeed: +(this.state.horizonSpeed ?? 0).toFixed(2),
        steer: +controls.steer.toFixed(3),
        throttle: +controls.throttle.toFixed(3),
        brake: +controls.brake.toFixed(3),
        targetLimitReason: this.state.targetLimitReason ?? 'NONE',
        throttleLimitReason: this.state.throttleLimitReason ?? 'NONE',
        brakeReason: this.state.brakeReason ?? 'NONE',
        brakingMarginMeters: +(this.state.brakingMarginMeters ?? 0).toFixed(1),
        clearFullThrottleEligible: Boolean(this.state.clearFullThrottleEligible),
      });
      if (this.trace.length >= 6000) {
        this.trace.splice(0, 2000);
      }
    }

    // Return final commands
    return {
      steer: controls.steer || 0,
      throttle: controls.throttle || 0,
      brake: controls.brake || 0,
      reverse: controls.reverse || false
    };
  }
}

export function createNovaDriver(config) {
  return new NovaDriver(config);
}
