// DeepSeek Longitudinal Control
// Force-budget pedal mapping. Throttle is not a fraction of the remaining
// friction circle: it is the fraction of the drive force actually required to
// reach the profile's speed at the tracking lookahead. Braking is only ever
// planned inside a brake event, or requested by traffic/safety with a cause;
// a small deceleration shortfall is handled by lifting, never by stabbing the
// brake.
//
// The profile is capped by the *actual* grip available for the curvature the
// car is really on, so tracking error cannot silently turn the plan into an
// over-speed entry.

import { clamp } from '../../sim/math.js';
import { BRAKE_CAUSES } from './brake-intent.js';

export function createLongitudinal(options = {}) {
  const o = {
    accelGain: 1.0,
    brakeGain: 1.0,
    brakeThreshold: 0.45,
    speedTrim: 0.22,
    // The plan is baked at the peak the tyres can hold; the driver is not yet
    // accurate enough to sit exactly there, so the grip cap carries a reserve.
    gripMargin: 0.9,
    ...options,
  };
  return {
    command(ego, model, envelope, profile, path, { allowBrake = true, cause = BRAKE_CAUSES.PLANNED, speedScale = 1, startIndex = 0, kappaOverride = null } = {}) {
      const v = Math.max(1, ego.speed);
      const count = path.ds.length;
      const iCar = startIndex % count;
      const mass = envelope.mass;
      const drag = envelope.dragForce(v);
      // Grip cap: the highest speed the real curvature at the car's position can
      // support with a small reserve. The caller may supply a smoothed curvature
      // estimate; a pointwise one flickers between rebuilds.
      const kappaNow = Math.max(Math.abs(kappaOverride ?? path.kappa[iCar]), 1e-6);
      let vGrip = Math.max(4, v);
      for (let k = 0; k < 4; k++) vGrip = Math.sqrt(o.gripMargin * envelope.latMax(vGrip) / kappaNow);
      // The friction ellipse must be evaluated against the lateral demand the
      // car is about to make, not only the one it has already made: measured ay
      // lags a new steering input by the tyre relaxation length, and that lag is
      // exactly what lets full drive break the rear loose mid-corner.
      const latDemand = Math.min(v * v * kappaNow, envelope.latMax(v));
      const latAccel = Math.max(Math.abs(ego.ay ?? 0), latDemand);

      // Most demanding planned deceleration inside the braking horizon, with
      // every profile target limited by the grip cap.
      const horizon = clamp(v * 1.8, 30, 150);
      let worstDecel = 0, worstAt = 0, travelled = 0;
      let i = iCar;
      while (travelled < horizon) {
        i = (i + 1) % count;
        travelled += path.ds[(i - 1 + count) % count];
        const target = Math.min(profile.v[i] * speedScale, vGrip);
        const decel = (v * v - target * target) / (2 * travelled);
        if (decel > worstDecel) { worstDecel = decel; worstAt = travelled; }
      }

      if (allowBrake && worstDecel > o.brakeThreshold) {
        const forceNeeded = mass * worstDecel + drag;
        const forceMax = Math.max(1, envelope.brakeForce(v, latAccel));
        const brake = clamp(o.brakeGain * forceNeeded / forceMax, 0, 1);
        return { throttle: 0, brake, cause, requiredDecel: worstDecel, requiredAccel: 0, distance: worstAt, vGrip };
      }

      // Acceleration: drive force required to reach the profile speed at the
      // near lookahead, plus a small trim on the current speed error.
      const driveForce = Math.max(1, envelope.driveForceAt(v, latAccel));
      const lookahead = clamp(v * 0.35, 5, 30);
      let i2 = iCar, dist = 0;
      while (dist < lookahead) {
        i2 = (i2 + 1) % count;
        dist += path.ds[(i2 - 1 + count) % count];
      }
      const vTarget = Math.min(profile.v[i2] * speedScale, vGrip);
      const aReq = Math.max(0, (vTarget * vTarget - v * v) / (2 * Math.max(3, dist)))
        + o.speedTrim * Math.max(0, vTarget - v);
      const forceNeeded = mass * aReq + drag;
      let throttle = clamp(o.accelGain * forceNeeded / driveForce, 0, 1);
      if (worstDecel > 0.05) throttle *= clamp(1 - worstDecel / o.brakeThreshold, 0, 1);
      return { throttle, brake: 0, cause: null, requiredDecel: worstDecel, requiredAccel: aReq, distance: worstAt, vGrip };
    },
  };
}
