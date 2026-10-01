// DeepSeek Physical Envelope
// A closed-form performance model of the GT plant: lateral capability, drive
// capability, braking capability and drag, all as functions of speed. It is
// derived from the exact force laws used by sim/tyre.js and sim/vehicle.js so
// the global optimiser and the controller reason in the same units as the
// plant. `tools/identify-plant.mjs` measures this model against the real
// vehicle and reports the calibration error.

import { clamp } from '../../sim/math.js';

const G = 9.81;
const RHO = 1.225;

export function createEnvelope(spec, {
  surfaceGrip = 1,
  fuelKg = 20,
  wing = 6,
  platform = 1,
  drivetrainEfficiency = 0.91,
  // The analytic peak force is not what a car extracts in a lap: combined-slip
  // saturation (shape factor), tyre temperature/pressure and transients cost
  // roughly 15-20%. `tools/identify-lat.mjs` measures the plant's sustained
  // lateral capability and this factor is calibrated against it.
  tyreFactor = 0.80,
  // Measured capability curves (artifacts/plant-identification-v2.json). When
  // supplied they REPLACE the analytic laws for that channel, so a measured
  // brake capability cannot be hidden inside a single scalar again.
  //   { latMax: [[v, m/s^2], ...], driveForce: [[v, N], ...], brakeForce: [[v, N], ...] }
  curves = null,
  calibration = {},
} = {}) {
  const mass = spec.mass + fuelKg;
  const cl = spec.cl + (wing - 6) * 0.11;
  const cd = spec.cd + (wing - 6) * 0.013;
  const rearStatic = 1 - spec.frontWeight;
  const rearAero = spec.key === 'gt' ? 0.57 : 1 - spec.frontAero;
  const iso = 0.5 * RHO;
  const latScale = calibration.lat ?? 1;
  const driveScale = calibration.drive ?? 1;
  const brakeScale = calibration.brake ?? 1;

  const downforce = (v) => iso * v * v * spec.area * cl * platform;
  const dragForce = (v) => iso * v * v * spec.area * cd;
  const mu = (load) => spec.tyreGrip * surfaceGrip * tyreFactor * 1.48
    * clamp(1 - 0.13 * Math.log(Math.max(0.1, load / 3300)), 0.68, 1.18);

  const normalAt = (v) => mass * G + downforce(v);

  // Measured-curve interpolation: clamped at both ends so the planner can never
  // extrapolate above the fastest measured point.
  const measured = (pairs, v, fallback) => {
    if (!pairs || !pairs.length) return fallback();
    if (v <= pairs[0][0]) {
      // Scale linearly from the origin to the first sample instead of clamping
      // to a constant, so low-speed behaviour stays physical.
      return (pairs[0][1] / pairs[0][0]) * v;
    }
    for (let i = 1; i < pairs.length; i++) {
      if (v <= pairs[i][0]) {
        const [v0, a0] = pairs[i - 1], [v1, a1] = pairs[i];
        return a0 + (a1 - a0) * ((v - v0) / Math.max(1e-9, v1 - v0));
      }
    }
    return pairs[pairs.length - 1][1];
  };

  function latMax(v) {
    if (v < 0.5) return 14 * latScale;
    if (curves?.latMax) return measured(curves.latMax, v) * latScale;
    const n = normalAt(v);
    const aero = mu(n / 4) * n / mass * latScale;
    const steer = v * v * Math.tan(spec.steeringLock) / spec.wheelbase;
    return Math.min(aero, steer);
  }

  function driveForce(v) {
    if (curves?.driveForce) return measured(curves.driveForce, v);
    let best = 0;
    for (let gi = 1; gi < spec.gears.length; gi++) {
      const ratio = spec.gears[gi] * spec.finalDrive;
      const rpm = Math.abs(v) / spec.radius * ratio * 9.5493;
      if (rpm < 1400 || rpm > 8100) continue;
      const curve = clamp(1 - ((rpm - 5500) / 6700) ** 2, 0.45, 1);
      const force = spec.maxTorque * curve * ratio * drivetrainEfficiency / spec.radius;
      if (force > best) best = force;
    }
    return best;
  }

  function driveForceAt(v, latAccel = 0, longGuess = 3) {
    const n = normalAt(v);
    // Longitudinal load transfer under acceleration adds rear normal load.
    const nRear = Math.max(200, n * rearStatic + longGuess * mass * spec.cg / spec.wheelbase);
    const grip = mu(nRear / 2) * nRear;
    const r = clamp(latAccel / latMax(v), 0, 1);
    return Math.min(driveForce(v), grip) * Math.sqrt(Math.max(0.04, 1 - r * r)) * driveScale;
  }

  // Brake torque in the plant is per wheel; bias splits it across the axles and
  // sums to one, so the total wheel force is 2 * brakeTorque / radius.
  function brakeForce(v, latAccel = 0) {
    const r = clamp(latAccel / latMax(v), 0, 1);
    if (curves?.brakeForce) {
      // Measured full-brake force is the net capability of the whole car; the
      // ellipse term only shapes the combined-slip part of it.
      return measured(curves.brakeForce, v) * Math.sqrt(Math.max(0.04, 1 - r * r)) * brakeScale;
    }
    const n = normalAt(v);
    const grip = mu(n / 4) * n;
    const force = Math.min(2 * spec.brakeTorque / spec.radius, grip);
    return force * Math.sqrt(Math.max(0.04, 1 - r * r)) * brakeScale;
  }

  function driveMax(v, latAccel = 0, longGuess = 3) {
    return driveForceAt(v, latAccel, longGuess) / mass;
  }

  function brakeMax(v, latAccel = 0) {
    return brakeForce(v, latAccel) / mass;
  }

  function curveLimit(kappaAbs) {
    if (kappaAbs < 1e-6) return 120;
    let v = 40;
    for (let i = 0; i < 8; i++) {
      const target = Math.sqrt(latMax(v) / kappaAbs);
      v = v + (target - v) * 0.7;
    }
    return v;
  }

  let vMax = 0;
  {
    let lo = 20, hi = 130;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (driveForce(mid) > dragForce(mid)) lo = mid; else hi = mid;
    }
    const topRatio = spec.gears[spec.gears.length - 1] * spec.finalDrive;
    const rpmCap = 8100 / 9.5493 / topRatio * spec.radius;
    vMax = Math.min(lo, rpmCap);
  }

  return {
    spec, mass, cl, cd, wing, surfaceGrip,
    downforce, dragForce, mu, latMax, driveForce, driveForceAt, brakeForce, driveMax, brakeMax, curveLimit,
    vMax,
  };
}
