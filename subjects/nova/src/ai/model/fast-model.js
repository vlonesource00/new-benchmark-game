// M_FAST — the reduced-order model the planner and controller optimise through.
//
// It is NOT a second physics engine and it does not pretend to be one. It is the
// smallest model that still contains the effects the quasi-steady planner
// currently ignores, parameterised entirely by measured plant data
// (artifacts/plant-identification-v2.json):
//
//   * steering actuator lag        tau = 1/12 s (measured t63 0.075 s)
//   * yaw follows the steering through the kinematic relation with the measured
//     understeer gradient (K_us ~ -1e-4 .. -6e-4 rad/(m/s^2): essentially neutral)
//   * lateral capability           measured latMax(v), no scaling fudge
//   * longitudinal capability      measured drive / brake / coast curves
//   * combined-slip coupling       friction ellipse on the remaining budget
//   * tyre relaxation length       0.33 m measured (< 1% of a braking zone)
//
// The one deliberate reduction is zero body slip (beta = 0). The plant's peak
// lateral force sits at ~15 deg of slip, so this is the dominant M_FAST error and
// tools/model-error.mjs measures exactly where it bites.

import { clamp } from '../../sim/math.js';

const G = 9.81;
const RHO = 1.225;

const interp = (pts, v) => {
  if (!pts.length) return 0;
  if (v <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][0]) {
      const [v0, a0] = pts[i - 1], [v1, a1] = pts[i];
      return a0 + (a1 - a0) * ((v - v0) / Math.max(1e-9, v1 - v0));
    }
  }
  return pts[pts.length - 1][1];
};

// Smooth monotone-ish interpolant for capability curves: interpolate in log v
// and clamp to the measured brackets so the model never extrapolates upwards.
const curve = (pairs) => (v) => interp(pairs, Math.max(pairs[0][0], Math.min(pairs[pairs.length - 1][0], v)));

export function createFastModel({ spec, identification, fuelKg = 20 }) {
  const T = identification.tests;
  const mass = spec.mass + fuelKg;
  const L = spec.wheelbase;
  const a = spec.frontWeight * L;
  const b = (1 - spec.frontWeight) * L;
  const cdA = spec.area * spec.cd;
  const clA = spec.area * spec.cl;

  const latMaxOf = curve(T.capability.map((c) => [c.v, c.latMax]));
  const driveNetOf = curve(T.drive.bins.map((c) => [c.v, c.value]));
  const brakeOf = curve(T.brake.bins.map((c) => [c.v, c.value]));
  const coastOf = curve(T.coast.bins.map((c) => [c.v, c.value]));

  // Analytic drag and rolling exactly as the plant computes them, so the drive
  // curve can be converted from net to gross acceleration.
  const dragAccel = (v) => (0.5 * RHO * v * v * cdA) / mass;
  const downforce = (v) => 0.5 * RHO * v * v * clA;
  const rollAccel = (v) => (0.013 * (mass * G + downforce(v)) * Math.tanh(v * 2)) / mass;
  const engineBrakeAccel = 0.33; // measured: 2 * 22 N.m * ratio / radius / mass, top gear

  const params = {
    mass, wheelbase: L, aToFront: a, aToRear: b,
    tauSteer: 1 / 12,
    kus: 0,
    cdA, clA,
    latMaxAt: (v) => latMaxOf(v),
    driveAccelGross: (v) => driveNetOf(v) + dragAccel(v) + rollAccel(v) + engineBrakeAccel,
    // The measured full-brake curve is the NET deceleration of a stop (it already
    // contains drag, rolling and engine braking), so the tyre contribution is
    // what is left after the coast term. Subtracting the coast twice made M_FAST
    // brake ~4 m/s^2 too hard.
    brakeAccelGross: (v) => Math.max(0, brakeOf(v) - coastOf(v)),
    brakeAccelNet: (v) => brakeOf(v),
    coastAccel: (v) => coastOf(v),
    latMaxSamples: T.capability.map((c) => [c.v, c.latMax]),
  };

  return {
    params,
    init({ x = 0, z = 0, yaw = 0, u = 0, r = 0, steer = 0 } = {}) {
      return { x, z, yaw, u, r, steer, ax: 0, ay: 0 };
    },
    // cmd: { steer, throttle, brake }; mutates and returns the state.
    step(s, cmd, dt) {
      const lock = spec.steeringLock;
      const steerCmd = clamp(cmd.steer ?? 0, -1, 1) * lock;
      const alpha = 1 - Math.exp(-dt / params.tauSteer);
      s.steer += (steerCmd - s.steer) * alpha;

      const u = Math.max(1, s.u);
      const kappa = Math.tan(s.steer) / (L + params.kus * u * u);
      let rCmd = u * kappa;
      const ayCap = latMaxOf(u);
      rCmd = clamp(rCmd, -ayCap / u, ayCap / u);
      s.r = rCmd;
      const ay = u * s.r;
      const ratio = clamp(Math.abs(ay) / Math.max(0.1, ayCap), 0, 1);
      const ellipse = Math.sqrt(Math.max(0.04, 1 - ratio * ratio));

      const throttle = clamp(cmd.throttle ?? 0, 0, 1);
      const brake = clamp(cmd.brake ?? 0, 0, 1);
      const grossCap = params.driveAccelGross(u) * ellipse;
      const brakeCap = params.brakeAccelGross(u) * ellipse;
      // The coast term (drag + rolling + engine braking) always applies; the
      // drive curve was converted net-to-gross so full throttle recovers the
      // measured accel exactly.
      s.ax = throttle * grossCap - brake * brakeCap - coastOf(u);

      s.u = Math.max(0, s.u + s.ax * dt);
      s.ay = s.u * s.r;
      s.yaw += s.r * dt;
      s.x += s.u * Math.sin(s.yaw) * dt;
      s.z += s.u * Math.cos(s.yaw) * dt;
      return s;
    },
  };
}

// Convenience: build a model directly from the identification artifact on disk.
export async function loadFastModel(spec, artifactPath) {
  const fs = await import('node:fs');
  const identification = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  return createFastModel({ spec, identification });
}
