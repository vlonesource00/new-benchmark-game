// DeepSeek Lateral Tracker
// Pure pursuit to a lookahead point on the plan, curvature feedforward over the
// lookahead and yaw-rate damping. Pure pursuit is inherently stable: the
// steering demand grows with the angle to the target point and the lookahead
// grows with speed, which keeps the loop gain bounded.
//
// The tracker follows whatever path it is given (global race line or local
// short-horizon plan) and starts from `startIndex` so local arrays can be used
// without a global station lookup.
//
// Sign convention (verified against the plant): positive steering increases
// yaw; heading = atan2(tx, tz); n = (tz, -tx) is the +q direction.

import { angle, clamp } from '../../sim/math.js';

const wrapIndex = (i, n) => ((Math.round(i) % n) + n) % n;

export function createTracker(options = {}) {
  const g = {
    lookahead: 0.48,
    minLookahead: 7,
    maxLookahead: 26,
    ff: 1.0,
    yaw: 0.22,
    kp: 1.0,
    kus: 0.0008,
    maxSteerRate: 4.0,
    ...options,
  };
  let previousSteer = 0;
  return {
    gains: g,
    reset() { previousSteer = 0; },
    command(ego, path, dt, startIndex = 0) {
      const spec = ego.spec;
      const count = path.n;
      // The local plan is an OPEN sub-path: wrapping past its end would aim the
      // car at index 0, which is metres behind it.
      const closed = path.closed !== false;
      const speed = Math.max(2.5, ego.speed);
      const iCar = closed ? wrapIndex(startIndex, count) : clamp(Math.round(startIndex), 0, Math.max(0, count - 2));
      const last = count - 1;
      const L = clamp(g.lookahead * speed, g.minLookahead, g.maxLookahead);
      let iRef = iCar, travelled = 0;
      while (travelled < L) {
        const next = closed ? (iRef + 1) % count : Math.min(last, iRef + 1);
        if (next === iRef) break;
        iRef = next;
        travelled += path.ds[closed ? wrapIndex(iRef - 1, count) : iRef - 1];
      }
      const dx = path.px[iRef] - ego.x, dz = path.pz[iRef] - ego.z;
      const alpha = angle(Math.atan2(dx, dz) - ego.yaw);
      const pp = Math.atan2(2 * spec.wheelbase * Math.sin(alpha), Math.max(3, travelled));
      let kappaSum = 0, steps = 0;
      if (closed) {
        for (let i = iCar; i !== iRef; i = (i + 1) % count) { kappaSum += path.kappa[i]; steps++; }
      } else {
        for (let i = iCar; i < iRef; i++) { kappaSum += path.kappa[i]; steps++; }
      }
      const kappaRef = steps ? kappaSum / steps : path.kappa[iCar];
      const ff = g.ff * Math.atan(spec.wheelbase * kappaRef) + g.kus * speed * speed * kappaRef;
      const yawErr = ego.yawRate - speed * path.kappa[iCar];
      const damp = -g.yaw * yawErr;
      const steerAngle = g.kp * pp + ff + damp;
      const elat = (ego.x - path.px[iCar]) * path.nx[iCar] + (ego.z - path.pz[iCar]) * path.nz[iCar];
      const ehead = angle(ego.yaw - path.heading[iCar]);
      const raw = clamp(steerAngle / spec.steeringLock, -1, 1);
      const maxStep = g.maxSteerRate * dt;
      const steer = clamp(raw, previousSteer - maxStep, previousSteer + maxStep);
      previousSteer = steer;
      return { steer, pp, alpha, ff, damp, kappaRef, elat, ehead };
    },
  };
}
