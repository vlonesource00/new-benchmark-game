// DeepSeek Safety Supervisor
// A fast, independent layer that only intervenes for the situations the driver
// stack is not allowed to get wrong: a spin, a stuck car, an off-road excursion
// and a beached car. It never improves pace, and every intervention is counted
// so a supervisor that fires constantly shows up as a planner failure instead of
// hiding as a crutch.
//
// Design rules learned from the plant (measured, not assumed):
//   * Recovery steering must be slew limited. A snap steer command while the
//     car is already yawing breaks rear grip and turns a wide moment into a
//     30 m tank-slapper across the track.
//   * Recovery throttle off-road must beat rolling resistance. Anything near
//     idle beaches the car against the barrier and it never leaves.
//   * Leaving the asphalt by a few centimetres is a kerb, not a crash: only
//     gravel/grass counts as off-road, so a normal track-limit moment does not
//     drag the supervisor into the loop.
//   * With no forward progress, reverse is the only move that frees the car; it
//     must last long enough to clear the barrier and must steer the nose back
//     toward the track centre.

import { clamp, angle } from '../../sim/math.js';
import { BRAKE_CAUSES } from '../control/brake-intent.js';

const OFF_ROAD_ZONES = new Set(['gravel', 'grass']);

export function createSupervisor(options = {}) {
  const o = {
    stuckSpeed: 1.6,
    stuckTime: 0.9,
    beachedSpeed: 2.2,
    beachedTime: 0.7,
    reverseTime: 2.4,
    reverseThrottle: 0.6,
    reverseSteer: 0.5,
    offRoadThrottle: 0.5,
    offRoadBrake: 0.5,
    turnHeading: 1.7,
    turnReverseTime: 2.2,
    spinHeading: 1.1,
    spinSpeed: 12,
    counterSteer: 0.55,
    steerRate: 2.2,
    holdTime: 0.35,
    ...options,
  };
  let stuckTimer = 0;
  let beachedTimer = 0;
  let reverseTimer = 0;
  let holdTimer = 0;
  let steerState = 0;
  let intervening = false;
  let turnPhase = 0;
  let phaseTimer = 0;
  const interventions = { spin: 0, stuck: 0, offroad: 0, rejoin: 0, turn: 0 };

  return {
    interventions,
    reset() {
      stuckTimer = 0; beachedTimer = 0; reverseTimer = 0; holdTimer = 0;
      steerState = 0; intervening = false; turnPhase = 0; phaseTimer = 0;
      interventions.spin = 0; interventions.stuck = 0; interventions.offroad = 0; interventions.rejoin = 0; interventions.turn = 0;
    },
    // objective: the driver's preferred command for this tick.
    supervise({ ego, model, line, iGlobal, dt, objective }) {
      const headingError = angle(ego.yaw - line.path.heading[iGlobal]);
      const offRoad = OFF_ROAD_ZONES.has(ego.zone) || Math.abs(ego.q) > model.halfWidth + model.curbWidth;
      const onKerb = !offRoad && Math.abs(ego.q) > model.halfWidth;
      if (ego.speed < o.stuckSpeed) stuckTimer += dt; else stuckTimer = 0;
      if (offRoad && ego.speed < o.beachedSpeed) beachedTimer += dt; else beachedTimer = 0;
      if (reverseTimer > 0) reverseTimer -= dt;
      else reverseTimer = Math.max(-1, reverseTimer - dt);
      if (holdTimer > 0) holdTimer -= dt;

      // Steering slew limiter shared by every recovery mode.
      const slew = (target) => {
        const maxStep = o.steerRate * dt;
        steerState = clamp(clamp(target, -1, 1), steerState - maxStep, steerState + maxStep);
        return steerState;
      };
      // Aim at a point on the race line a short distance ahead, so the rejoin
      // geometry is the same on the kerb and in the gravel. Deliberately
      // shallow: rejoining at a large angle is how a spin becomes an incident.
      const rejoinSteer = (look) => {
        const ahead = Math.max(6, look);
        const iTarget = model.index(ego.s + ahead);
        const target = model.point(ego.s + ahead, clamp(line.q[iTarget] * 0.9, -model.qPlan, model.qPlan));
        const desired = Math.atan2(target.x - ego.x, target.z - ego.z);
        return angle(desired - ego.yaw) * 0.9;
      };

      // 0. Facing the wrong way. A settle loop cannot fix this -- the car needs
      //    a reverse turn -- and without it the car thrashes spin/stuck forever
      //    (measured: 200 s at v=0 with the heading 180 degrees out).
      //    Reverse steering is inverted relative to forward, so the sign that
      //    sweeps the nose back toward the path while reversing is
      //    +sign(headingError); verified against the plant.
      const backwards = Math.abs(headingError) > o.turnHeading;
      if (turnPhase === 0 && backwards) { turnPhase = 1; phaseTimer = 0; interventions.turn++; }
      if (turnPhase) {
        intervening = true;
        phaseTimer += dt;
        if (turnPhase === 1) {
          if (ego.speed < 2.5 || phaseTimer > 2.0) { turnPhase = 2; phaseTimer = 0; }
          else {
            return {
              steer: slew(-Math.sign(ego.yawRate || headingError) * 0.25),
              throttle: 0, brake: 0.45, reverse: false,
              cause: BRAKE_CAUSES.RECOVERY, supervisor: 'TURN-BRAKE',
            };
          }
        }
        if (turnPhase === 2) {
          if (!backwards || phaseTimer > o.turnReverseTime) { turnPhase = 3; phaseTimer = 0; }
          else {
            return {
              steer: slew(Math.sign(headingError) * o.reverseSteer),
              throttle: o.reverseThrottle, brake: 0, reverse: true,
              cause: BRAKE_CAUSES.RECOVERY, supervisor: 'TURN-REVERSE',
            };
          }
        }
        if (turnPhase === 3) {
          if (Math.abs(headingError) < 0.5 || phaseTimer > 2.5) { turnPhase = 0; }
          else {
            // Gather, then turn. A rear-drive car cannot be steered back onto
            // the line while it is still rotating: full lock plus throttle just
            // spins it again and the recovery loops (measured: 52 s of
            // TURN-FORWARD/TURN-REVERSE at v=0). So straighten first, build
            // speed, and only then take a shallow angle back to the line.
            const slip = angle(Math.atan2(ego.vx, ego.vz) - ego.yaw);
            const gathered = Math.abs(slip) < 0.25 && Math.abs(ego.yawRate) < 0.6;
            return {
              steer: slew(gathered ? clamp(rejoinSteer(10 + 0.3 * ego.speed) * 0.8, -1, 1) : -Math.sign(slip || ego.yawRate || 1) * 0.2),
              throttle: gathered ? (offRoad ? 0.4 : 0.5) : 0.15,
              brake: 0, reverse: false,
              cause: BRAKE_CAUSES.RECOVERY, supervisor: 'TURN-FORWARD',
            };
          }
        }
      }

      // 1. Beached / stuck: no forward progress. Reverse out, then let the
      //    off-road branch drive the car back on.
      if ((beachedTimer > o.beachedTime || stuckTimer > o.stuckTime) && reverseTimer <= -0.3) {
        reverseTimer = o.reverseTime;
        beachedTimer = 0;
        stuckTimer = 0;
        interventions.stuck++;
      }
      if (reverseTimer > 0) {
        intervening = true;
        // While reversing the nose swings opposite to the steering, so steer
        // toward the centre of the track (sign of -q) to pull the car away from
        // the barrier it is beached on.
        const towardCentre = -Math.sign(ego.q || 1);
        return {
          steer: slew(towardCentre * o.reverseSteer),
          throttle: o.reverseThrottle,
          brake: 0,
          reverse: true,
          cause: BRAKE_CAUSES.RECOVERY,
          supervisor: 'STUCK',
        };
      }

      // 2. Spin: yaw out of phase with the path. Cut drive, damp the yaw with
      //    counter-steer and only a light brake -- braking hard while yawing
      //    takes the front tyres out of the friction circle and deepens it.
      const spun = Math.abs(headingError) > o.spinHeading && Math.abs(headingError) < o.turnHeading && ego.speed > 2;
      const unsettled = Math.abs(ego.yawRate) > 0.9 && ego.speed > 4;
      if (spun || unsettled) {
        intervening = true;
        interventions.spin++;
        holdTimer = o.holdTime;
        const yawRef = ego.speed * line.path.kappa[iGlobal];
        const yawErr = ego.yawRate - yawRef;
        const counter = clamp(-0.3 * yawErr, -o.counterSteer, o.counterSteer);
        const toward = clamp(-headingError * 0.9, -0.7, 0.7);
        const brake = ego.speed > o.spinSpeed ? 0.18 : 0.05;
        const throttle = ego.speed < 6 && !offRoad ? 0.25 : 0;
        return {
          steer: slew(counter + toward),
          throttle,
          brake,
          reverse: false,
          cause: BRAKE_CAUSES.RECOVERY,
          supervisor: 'SPIN',
        };
      }

      // 3. Off road. A sliding car cannot be steered: the front tyres are
      //    already past their peak, so asking for more lock only ploughed the
      //    car further out (measured: a car in the gravel at 26 m/s went from
      //    q=9.5 to q=15 with 0.5 of steer applied). The recovery is therefore
      //    straighten, brake, then turn.
      if (offRoad) {
        intervening = true;
        interventions.offroad++;
        holdTimer = o.holdTime;
        const velocityHeading = Math.atan2(ego.vx, ego.vz);
        const slip = angle(velocityHeading - ego.yaw);
        // Below walking pace the velocity heading is meaningless and the car
        // must simply drive out; a sliding test there latches and pins the car
        // in the gravel with the brakes on.
        const sliding = ego.speed > 4 && (Math.abs(slip) > 0.25 || Math.abs(headingError) > 0.5);
        if (sliding) {
          intervening = true;
          return {
            steer: slew(-Math.sign(slip || headingError) * Math.min(0.25, Math.abs(slip) * 0.3)),
            throttle: 0,
            brake: clamp(0.25 + 1.2 * Math.abs(slip), 0.25, o.offRoadBrake),
            reverse: false,
            cause: BRAKE_CAUSES.RECOVERY,
            supervisor: 'OFFROAD-BRAKE',
          };
        }
        const brake = ego.speed > 18 ? 0.2 : ego.speed > 9 ? 0.08 : 0;
        const throttle = ego.speed < 9 ? o.offRoadThrottle : 0.1;
        return {
          steer: slew(rejoinSteer(10 + 0.25 * ego.speed)),
          throttle,
          brake,
          reverse: false,
          cause: BRAKE_CAUSES.RECOVERY,
          supervisor: 'OFFROAD',
        };
      }
      // Kerb: hold the recovery for a moment so pace does not snap back mid-kerb.
      if (onKerb) holdTimer = Math.max(holdTimer, 0.15);

      // 4. Clear: hand the driver's own command back. The recovery steer rate is
      //    kept for the hold window so the hand-back is smooth, and a return to
      //    driver control after an excursion is counted as a rejoin.
      if (holdTimer > 0) {
        return {
          steer: slew(objective.steer),
          throttle: Math.min(objective.throttle, 0.6),
          brake: objective.brake,
          reverse: false,
          cause: BRAKE_CAUSES.RECOVERY,
          supervisor: 'REJOIN',
        };
      }
      if (intervening) { interventions.rejoin++; intervening = false; }
      return { ...objective, supervisor: null };
    },
  };
}
