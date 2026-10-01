// DeepSeek AI
// The complete driver stack behind one host-independent boundary:
//
//   DeepSeekObservation  ->  step(obs, dt)  ->  DeepSeekCommand
//
// The AI is constructed once with a track portrait, a physical envelope and a
// precomputed race line. It never imports or touches a Vehicle; the native game
// and (later) the shared benchmark each provide their own adapter that produces
// the same observation shape and consumes the same command shape.
//
// Control structure:
//   * global line     - where the lap should be driven (offline optimum)
//   * local plan      - a short-horizon quintic blend from the car's real state
//                        onto the line, with its own cornering and braking limits
//   * tracker         - pure pursuit + curvature feedforward + yaw damping
//   * longitudinal    - force-budget pedals against the local plan
//   * supervisor      - off-road / stuck / spin recovery

import { clamp, angle } from '../sim/math.js';
import { gripFactor } from '../sim/tyre.js';
import { createTracker } from './control/tracker.js';
import { createLongitudinal } from './control/longitudinal.js';
import { BRAKE_CAUSES } from './control/brake-intent.js';
import { buildLocalPlan } from './planning/local-plan.js';
import { createSupervisor } from './safety/supervisor.js';

export class DeepSeekAI {
  constructor({ model, envelope, line, options = {} }) {
    this.model = model;
    this.envelope = envelope;
    this.line = line;
    this.options = options;
    this.tracker = createTracker(options.tracker);
    this.supervisor = createSupervisor(options.supervisor);
    this.longitudinal = createLongitudinal(options.longitudinal);
    this.planInterval = options.planInterval ?? 1 / 60;
    this.planTimer = 0;
    this.local = null;
    this.mode = 'PACE';
    this.stuckTime = 0;
    this.recoverTime = 0;
    this.speedScale = 1;
    this.kappaCar = 0;
    this.state = {
      mode: 'PACE', intent: 'PACE', cause: null, steer: 0, rlat: 0, rhead: 0,
      targetSpeed: 0, requiredAccel: 0, requiredDecel: 0, plannedBrake: false, elapsed: 0,
    };
  }

  reset() {
    this.tracker.reset();
    this.supervisor.reset();
    this.stuckTime = 0;
    this.recoverTime = 0;
    this.speedScale = 1;
    this.kappaCar = 0;
    this.planTimer = 0;
    this.local = null;
    this.mode = 'PACE';
  }

  step(obs) {
    const dt = obs.dt;
    const ego = obs.ego;
    const model = this.model;
    this.state.elapsed += dt;
    const iGlobal = model.index(ego.s);

    // Local plan: a short-horizon trajectory from the car's actual state onto
    // the race line. Rebuilt at a fixed rate; the supervisor does not need it.
    this.planTimer += dt;
    if (!this.local || this.planTimer >= this.planInterval) {
      this.planTimer = 0;
      this.local = buildLocalPlan({ model, line: this.line, ego, envelope: this.envelope });
    }
    const plan = this.local;

    // Driver's own command for this tick.
    const lat = this.tracker.command(ego, plan.path, dt, plan.index);
    // Line error is measured against the *global* race line, not the local
    // blend: the blend follows the car, so its error is always ~zero and would
    // hide a car that is drifting away from the plan.
    const gElat = ego.q - this.line.q[iGlobal];
    const gEhead = angle(ego.yaw - this.line.path.heading[iGlobal]);
    // Cold tyres have less grip than the baked plan assumes. The plant's own
    // grip law (tyre.js) gives the ratio directly: a 25 C tyre has 67% of the
    // grip of an 85 C tyre, so the speed scale is its square root.
    let tyreScale = 1;
    if (ego.tyres?.length) {
      let grip = 0, wear = 0;
      for (const t of ego.tyres) { grip += gripFactor(t.core, t.pressure); wear += t.wear; }
      grip /= ego.tyres.length;
      wear /= ego.tyres.length;
      tyreScale = clamp(Math.sqrt(grip * (1 - wear * 0.35)), 0.6, 1);
    }
    const targetScale = clamp((this.options.planSpeedScale ?? 1) * tyreScale, 0.6, 1);
    this.speedScale += clamp(targetScale - this.speedScale, -2.0 * dt, 1.0 * dt);
    const speedScale = this.speedScale;
    // A lateral offset from the line changes the curvature the car actually
    // follows; carry that into the grip cap instead of penalising speed merely
    // for the existence of an error.
    const kappaEff = Math.abs(this.line.path.kappa[iGlobal]) * (1 + Math.abs(gElat) / 30) + Math.abs(gEhead) * 0.02;
    this.kappaCar += (kappaEff - this.kappaCar) * Math.min(1, 6 * dt);
    // Speed follows the global plan (a well-conditioned optimisation), while
    // steering follows the local trajectory that originates at the car.
    const cmd = this.longitudinal.command(ego, model, this.envelope, this.line.profile, this.line.path, {
      allowBrake: true,
      cause: BRAKE_CAUSES.PLANNED,
      speedScale,
      startIndex: iGlobal,
      kappaOverride: this.kappaCar,
    });
    // The safety layer has the final word: it returns the driver's command
    // untouched unless the car is spinning, stuck or off the road.
    const supervised = this.supervisor.supervise({
      ego, model, line: this.line, iGlobal, dt,
      objective: { steer: lat.steer, throttle: cmd.throttle, brake: cmd.brake, cause: cmd.cause, reverse: false },
    });

    this.state.rlat = gElat;
    this.state.rhead = gEhead;
    this.state.localElat = lat.elat;
    this.state.localEhead = lat.ehead;
    this.state.pp = lat.pp;
    this.state.alpha = lat.alpha;
    this.state.ff = lat.ff;
    this.state.damp = lat.damp;
    this.state.kappaRef = lat.kappaRef;
    this.state.requiredAccel = cmd.requiredAccel;
    this.state.requiredDecel = cmd.requiredDecel;
    this.state.plannedBrake = cmd.brake > 0;
    this.state.speedScale = speedScale;
    this.state.vGrip = cmd.vGrip;
    this.state.horizonSpeed = plan.profile.v[Math.min(plan.path.n - 1, Math.round(plan.path.n * 0.6))];
    this.state.mode = this.mode;
    this.state.intent = supervised.supervisor ? 'RECOVER' : 'PACE';
    this.state.supervisor = supervised.supervisor;
    this.state.cause = supervised.cause;
    this.state.steer = supervised.steer;
    this.state.targetSpeed = this.line.profile.v[iGlobal];
    this.state.yawRateError = ego.yawRate - ego.speed * this.line.path.kappa[iGlobal];
    return { steer: supervised.steer, throttle: supervised.throttle, brake: supervised.brake, reverse: Boolean(supervised.reverse) };
  }
}
