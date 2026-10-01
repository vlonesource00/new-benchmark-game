// src/ai/model/transient-model.js
// M_RT — Scientifically Identified Reduced-Order Transient Vehicle Model
// 
// Physical Formulation:
//   - World-Space Authoritative Kinematics:
//       dot(x) = vx * sin(yaw) + vy * cos(yaw)
//       dot(z) = vx * cos(yaw) - vy * sin(yaw)
//       dot(yaw) = r
//     (Zero division by 1 - q*kappa; completely avoids Frenet fold singularities)
//   - Axle Geometry & Static Loads (matching canonical plant exactly):
//       a_front = (1 - wf) * L = 1.4734 m (distance CG -> front axle)
//       b_rear  = wf * L       = 1.3066 m (distance CG -> rear axle)
//       Fz_front_static = mg * wf = 0.47 mg
//       Fz_rear_static  = mg * (1 - wf) = 0.53 mg
//   - Dynamic Load Transfer:
//       Delta_Fz = clamp(ax, -22, 18) * mass * cg / L
//       Braking (ax < 0) => front load increases, rear load decreases.
//       Acceleration (ax > 0) => rear load increases, front load decreases.
//   - Axle-Specific Combined Slip:
//       Rear-wheel drive: acceleration acts solely on rear wheels (front lateral unattenuated).
//       Braking: split 58% front / 42% rear via brakeBias.
//   - Identified Actuator Dynamics:
//       tauSteer = 1/12 s (~0.0833 s), tauLong = 0.0583 s (from plant step identification).
//   - Sourced Tyre Parameters:
//       Calibrated from artifacts/mrt-identification-v1.json.
//   - Continuous 4th-order Runge-Kutta (RK4) integration at 120 Hz.

import fs from 'node:fs';
import path from 'node:path';
import { clamp, angle } from '../../sim/math.js';
import { CAR_CLASSES } from '../../sim/car-specs.js';

const G = 9.81;
const RHO = 1.225;

const interp = (pts, v) => {
  if (!pts || !pts.length) return 0;
  if (v <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][0]) {
      const [v0, a0] = pts[i - 1], [v1, a1] = pts[i];
      return a0 + (a1 - a0) * ((v - v0) / Math.max(1e-9, v1 - v0));
    }
  }
  return pts[pts.length - 1][1];
};

const curve = (pairs) => (v) => interp(pairs, Math.max(pairs[0][0], Math.min(pairs[pairs.length - 1][0], v)));

export class TransientModel {
  /**
   * @param {Object} spec Car class specification (e.g. CAR_CLASSES.gt)
   * @param {Object} identification Identified parameters (artifacts/mrt-identification-v1.json)
   * @param {Object} [options]
   * @param {number} [options.fuelL=35] Fuel level in liters (0.75 kg/L)
   */
  constructor(spec = CAR_CLASSES.gt, identification = null, options = {}) {
    this.spec = spec;
    this.identification = identification;

    // Mass and fuel semantics: exactly match the canonical plant
    // Plant: mass = spec.mass + fuel * 0.75
    const fuelL = options.fuelL ?? (identification?.effectiveMass?.fuelCapacityL ?? 35);
    const fuelDensity = identification?.effectiveMass?.fuelDensityKgPerL ?? 0.75;
    this.fuelMass = fuelL * fuelDensity; // 26.25 kg
    this.mass = spec.mass + this.fuelMass; // 1316.25 kg for GT

    // Geometry: distance from CG to front/rear axles
    const L = spec.wheelbase; // 2.78 m
    const wf = spec.frontWeight; // 0.47
    this.wheelbase = L;
    this.frontWeight = wf;
    this.a_front = (1 - wf) * L; // 1.4734 m
    this.b_rear = wf * L; // 1.3066 m
    this.cg = spec.cg ?? 0.43;
    this.yawInertia = spec.yawInertia ?? 2030;
    this.steeringLock = spec.steeringLock ?? 0.48;
    this.brakeBias = spec.brakeBias ?? 0.58;
    this.driveAxle = spec.drive ?? 'rear';

    // Actuator time constants
    this.tauSteer = identification?.actuatorDynamics?.tauSteer ?? (1 / 12);
    this.tauLong = identification?.actuatorDynamics?.tauLong ?? 0.0583;

    // Aerodynamics
    this.area = spec.area ?? 1.9;
    this.cd = spec.cd ?? 0.64;
    this.cl = spec.cl ?? 2.25;
    this.frontAero = spec.frontAero ?? 0.43;
    this.rearAero = spec.key === 'gt' ? 0.57 : (1 - this.frontAero);

    // Tyre friction parameters
    const tf = identification?.tyreFriction;
    this.mu0 = tf?.mu0 ?? 1.48;
    this.Fz0 = tf?.Fz0 ?? 3300;
    this.c_mu = tf?.c_mu ?? 0.13;
    this.mu_min = tf?.mu_min ?? 0.68;
    this.mu_max = tf?.mu_max ?? 1.18;
    this.slipGain = tf?.slipGain ?? 8.6;
    this.postPeakDrop = tf?.postPeakDrop ?? 0.16;
    this.postPeakThreshold = tf?.postPeakThreshold ?? 1.4;
    this.postPeakWidth = tf?.postPeakWidth ?? 5.0;

    // Longitudinal capability curves from identification
    const lc = identification?.longitudinalCurves;
    if (lc) {
      this.driveNetOf = curve(lc.drive.bins.map((c) => [c.v, c.value]));
      this.brakeOf = curve(lc.brake.bins.map((c) => [c.v, c.value]));
      this.coastOf = curve(lc.coast.bins.map((c) => [c.v, c.value]));
    } else {
      this.driveNetOf = (v) => Math.max(0, 6.5 - 0.06 * v);
      this.brakeOf = (v) => Math.min(0, -12 - 0.04 * v);
      this.coastOf = (v) => -(0.015 * G + (0.5 * RHO * v * v * this.area * this.cd) / this.mass);
    }
  }

  /**
   * Initializes state vector.
   * Supports both Cartesian (x, z, yaw, u, v) and Frenet inputs.
   */
  init({
    x = 0, z = 0, yaw = 0,
    u = 0, v = 0, vx = 0, vy = 0,
    r = 0, steer = 0, delta = 0,
    fx = 0, beta = 0,
    s = 0, q = 0, e_psi = 0
  } = {}) {
    const initialVx = vx || u || 0;
    const initialVy = vy || v || (initialVx * Math.tan(beta || 0)) || 0;
    const initialDelta = delta || (steer * this.steeringLock) || 0;

    return {
      x,
      z,
      yaw,
      v_x: initialVx,
      v_y: initialVy,
      r,
      delta: initialDelta,
      F_x: fx,
      // Helper cached variables for telemetry and interface parity
      u: initialVx,
      v: initialVy,
      steer: initialDelta / this.steeringLock,
      speed: Math.hypot(initialVx, initialVy),
      beta: Math.atan2(initialVy, Math.max(0.1, initialVx)),
      ax: 0,
      ay: 0,
      s,
      q,
      e_psi
    };
  }

  /**
   * Evaluates continuous state derivatives in world space.
   * 
   * @param {Object} state Current state
   * @param {Object} cmd Control inputs: { steer, throttle, brake } or { delta_cmd, F_x_cmd }
   * @returns {Object} State derivatives
   */
  derivatives(state, cmd = {}) {
    const { x, z, yaw, v_x, v_y, r, delta, F_x } = state;

    // Resolve commanded road-wheel steer angle delta_cmd
    let delta_cmd = 0;
    if (cmd.delta_cmd !== undefined) {
      delta_cmd = clamp(cmd.delta_cmd, -this.steeringLock, this.steeringLock);
    } else if (cmd.steer !== undefined) {
      delta_cmd = clamp(cmd.steer, -1, 1) * this.steeringLock;
    } else {
      delta_cmd = delta;
    }

    // Resolve commanded longitudinal force F_x_cmd
    let F_x_cmd = 0;
    const v_pos = Math.max(0, v_x);
    if (cmd.throttle !== undefined || cmd.brake !== undefined) {
      const throttle = clamp(cmd.throttle ?? 0, 0, 1);
      const brake = clamp(cmd.brake ?? 0, 0, 1);

      const q_aero = 0.5 * RHO * v_pos * v_pos;
      const dragAccel = (q_aero * this.area * this.cd) / this.mass;
      const downforceN = q_aero * this.area * this.cl;
      const rollAccel = (0.013 * (this.mass * G + downforceN) * Math.tanh(v_pos * 2)) / this.mass;
      const engineBrakeAccel = 0.33;

      const grossDriveAccel = this.driveNetOf(v_pos) + dragAccel + rollAccel + engineBrakeAccel;
      const grossBrakeCap = Math.max(0, this.brakeOf(v_pos) - this.coastOf(v_pos)) * this.mass;
      
      // Demanded wheel brake torque converted to road force
      const brakeTorqueDemand = brake * (2 * (this.spec.brakeTorque ?? 6200) / (this.spec.radius ?? 0.335));
      // Tyre force cannot exceed the plant-identified saturation grip cap (modulated by ABS)
      const tyreBrakeForce = Math.min(brakeTorqueDemand, grossBrakeCap);
      const engineBrakeForce = (v_pos > 0.5 ? engineBrakeAccel : 0) * this.mass;

      // F_x represents net tyre longitudinal force (excluding chassis aero drag and tyre rolling resistance)
      F_x_cmd = throttle * grossDriveAccel * this.mass - tyreBrakeForce - engineBrakeForce;
    } else if (cmd.F_x_cmd !== undefined) {
      F_x_cmd = cmd.F_x_cmd;
    }

    // World kinematics (singularity-free)
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    const x_dot = v_x * sinYaw + v_y * cosYaw;
    const z_dot = v_x * cosYaw - v_y * sinYaw;
    const yaw_dot = r;

    // Chassis aerodynamics
    const q_aero = 0.5 * RHO * v_x * v_x;
    const F_downforce = q_aero * this.area * this.cl;
    const F_drag = q_aero * this.area * this.cd;
    const F_roll = 0.013 * (this.mass * G + F_downforce) * Math.tanh(v_x * 2);

    // Current longitudinal acceleration for dynamic load transfer
    const a_x = (F_x - F_drag - F_roll) / this.mass;

    // Dynamic longitudinal load transfer:
    // Braking (a_x < 0) => Delta_Fz < 0 => front load increases, rear decreases.
    // Acceleration (a_x > 0) => Delta_Fz > 0 => rear load increases, front decreases.
    const Delta_Fz = (clamp(a_x, -22, 18) * this.mass * this.cg) / this.wheelbase;

    const F_z_front = Math.max(100, this.mass * G * this.frontWeight - Delta_Fz + F_downforce * this.frontAero);
    const F_z_rear = Math.max(100, this.mass * G * (1 - this.frontWeight) + Delta_Fz + F_downforce * this.rearAero);

    // Axle-specific longitudinal force distribution & combined slip ellipses:
    let F_x_f = 0;
    let F_x_r = 0;
    if (F_x >= 0) {
      // Rear-wheel drive: front wheels are unpowered, 100% lateral budget available!
      F_x_f = 0;
      F_x_r = F_x;
    } else {
      // Braking: front/rear split governed by brake bias
      F_x_f = F_x * this.brakeBias;
      F_x_r = F_x * (1 - this.brakeBias);
    }

    // Tyre slip angles
    const v_x_safe = Math.max(1.5, Math.abs(v_x));
    const alpha_f = Math.atan2(v_y + this.a_front * r, v_x_safe) - delta;
    const alpha_r = Math.atan2(v_y - this.b_rear * r, v_x_safe);

    // Degressive tyre load sensitivity: mu(Fz)
    const mu_f = this.mu0 * clamp(1 - this.c_mu * Math.log(Math.max(0.1, F_z_front / this.Fz0)), this.mu_min, this.mu_max);
    const mu_r = this.mu0 * clamp(1 - this.c_mu * Math.log(Math.max(0.1, F_z_rear / this.Fz0)), this.mu_min, this.mu_max);

    const F_max_f = mu_f * F_z_front;
    const F_max_r = mu_r * F_z_rear;

    // Axle-specific combined-slip ellipse reductions
    const ellipse_f = Math.sqrt(Math.max(0.01, 1 - Math.pow(Math.min(0.999, Math.abs(F_x_f) / F_max_f), 2)));
    const ellipse_r = Math.sqrt(Math.max(0.01, 1 - Math.pow(Math.min(0.999, Math.abs(F_x_r) / F_max_r), 2)));

    // Slip shape function: tanh(sy) with post-peak softening
    const s_y_f = Math.tan(clamp(alpha_f, -1.2, 1.2)) * this.slipGain;
    const s_y_r = Math.tan(clamp(alpha_r, -1.2, 1.2)) * this.slipGain;

    const shape = (sy) => {
      const absSy = Math.abs(sy);
      const postPeak = clamp((absSy - this.postPeakThreshold) / this.postPeakWidth, 0, 1);
      return Math.tanh(absSy) * (1 - this.postPeakDrop * postPeak);
    };

    const F_y_f = -F_max_f * shape(s_y_f) * Math.sign(s_y_f) * ellipse_f;
    const F_y_r = -F_max_r * shape(s_y_r) * Math.sign(s_y_r) * ellipse_r;

    // Axle-specific friction circle clamping on longitudinal forces (anti-exploit)
    // Prevents non-physical longitudinal deceleration beyond tyre grip capacity
    const F_x_cap_f = Math.sqrt(Math.max(0, F_max_f * F_max_f - F_y_f * F_y_f));
    const F_x_cap_r = Math.sqrt(Math.max(0, F_max_r * F_max_r - F_y_r * F_y_r));

    let F_x_f_deliv = 0;
    let F_x_r_deliv = 0;
    if (F_x >= 0) {
      F_x_f_deliv = 0;
      F_x_r_deliv = Math.min(F_x, F_x_cap_r);
    } else {
      F_x_f_deliv = -Math.min(Math.abs(F_x_f), F_x_cap_f);
      F_x_r_deliv = -Math.min(Math.abs(F_x_r), F_x_cap_r);
    }
    let F_x_delivered = F_x_f_deliv * Math.cos(delta) + F_x_r_deliv;
    if (F_x_delivered < 0) {
      F_x_delivered *= Math.tanh(Math.max(0, v_x) * 2.0);
    }

    // Chassis equations of motion
    const v_x_dot = (F_x_delivered - F_drag - F_roll) / this.mass + v_y * r;
    const v_y_dot = (F_y_f * Math.cos(delta) + F_y_r) / this.mass - v_x * r;
    const r_dot = (this.a_front * F_y_f * Math.cos(delta) - this.b_rear * F_y_r) / this.yawInertia;

    // Actuator first-order lag dynamics
    const delta_dot = (delta_cmd - delta) / this.tauSteer;
    const F_x_dot = (F_x_cmd - F_x) / this.tauLong;

    const util_f = Math.hypot(F_x_f_deliv, F_y_f) / Math.max(1e-3, F_max_f);
    const util_r = Math.hypot(F_x_r_deliv, F_y_r) / Math.max(1e-3, F_max_r);

    return {
      x_dot,
      z_dot,
      yaw_dot,
      v_x_dot,
      v_y_dot,
      r_dot,
      delta_dot,
      F_x_dot,
      // Metadata
      a_x: (F_x_delivered - F_drag - F_roll) / this.mass,
      a_y: (F_y_f * Math.cos(delta) + F_y_r) / this.mass,
      F_z_front,
      F_z_rear,
      alpha_f,
      alpha_r,
      ellipse_f,
      ellipse_r,
      util_f,
      util_r,
      F_x_delivered
    };
  }

  /**
   * Continuous RK4 numerical integration.
   * Updates state in-place and returns it.
   */
  step(state, cmd = {}, dt = DT, track = null) {
    const maxSubDt = 0.5 * Math.min(this.tauLong, this.tauSteer);
    const subSteps = Math.max(1, Math.ceil(dt / maxSubDt));
    const h = dt / subSteps;

    for (let sub = 0; sub < subSteps; sub++) {
      const k1 = this.derivatives(state, cmd);

      const s2 = {
        x: state.x + 0.5 * h * k1.x_dot,
        z: state.z + 0.5 * h * k1.z_dot,
        yaw: state.yaw + 0.5 * h * k1.yaw_dot,
        v_x: state.v_x + 0.5 * h * k1.v_x_dot,
        v_y: state.v_y + 0.5 * h * k1.v_y_dot,
        r: state.r + 0.5 * h * k1.r_dot,
        delta: state.delta + 0.5 * h * k1.delta_dot,
        F_x: state.F_x + 0.5 * h * k1.F_x_dot
      };
      const k2 = this.derivatives(s2, cmd);

      const s3 = {
        x: state.x + 0.5 * h * k2.x_dot,
        z: state.z + 0.5 * h * k2.z_dot,
        yaw: state.yaw + 0.5 * h * k2.yaw_dot,
        v_x: state.v_x + 0.5 * h * k2.v_x_dot,
        v_y: state.v_y + 0.5 * h * k2.v_y_dot,
        r: state.r + 0.5 * h * k2.r_dot,
        delta: state.delta + 0.5 * h * k2.delta_dot,
        F_x: state.F_x + 0.5 * h * k2.F_x_dot
      };
      const k3 = this.derivatives(s3, cmd);

      const s4 = {
        x: state.x + h * k3.x_dot,
        z: state.z + h * k3.z_dot,
        yaw: state.yaw + h * k3.yaw_dot,
        v_x: state.v_x + h * k3.v_x_dot,
        v_y: state.v_y + h * k3.v_y_dot,
        r: state.r + h * k3.r_dot,
        delta: state.delta + h * k3.delta_dot,
        F_x: state.F_x + h * k3.F_x_dot
      };
      const k4 = this.derivatives(s4, cmd);

      // Apply RK4 weighted step
      state.x += (h / 6) * (k1.x_dot + 2 * k2.x_dot + 2 * k3.x_dot + k4.x_dot);
      state.z += (h / 6) * (k1.z_dot + 2 * k2.z_dot + 2 * k3.z_dot + k4.z_dot);
      state.yaw = angle(state.yaw + (h / 6) * (k1.yaw_dot + 2 * k2.yaw_dot + 2 * k3.yaw_dot + k4.yaw_dot));
      state.v_x += (h / 6) * (k1.v_x_dot + 2 * k2.v_x_dot + 2 * k3.v_x_dot + k4.v_x_dot);
      state.v_y += (h / 6) * (k1.v_y_dot + 2 * k2.v_y_dot + 2 * k3.v_y_dot + k4.v_y_dot);
      state.r += (h / 6) * (k1.r_dot + 2 * k2.r_dot + 2 * k3.r_dot + k4.r_dot);
      state.delta += (h / 6) * (k1.delta_dot + 2 * k2.delta_dot + 2 * k3.delta_dot + k4.delta_dot);
      state.F_x += (h / 6) * (k1.F_x_dot + 2 * k2.F_x_dot + 2 * k3.F_x_dot + k4.F_x_dot);

      if (sub === subSteps - 1) {
        state.ax = k1.a_x;
        state.ay = k1.a_y;
      }
    }

    // Helper properties
    state.u = state.v_x;
    state.v = state.v_y;
    state.speed = Math.hypot(state.v_x, state.v_y);
    state.beta = Math.atan2(state.v_y, Math.max(0.1, state.v_x));
    state.steer = state.delta / this.steeringLock;

    // Optional host track projection for Frenet diagnostics
    if (track && track.nearest) {
      const p = track.nearest(state.x, state.z);
      state.s = p.s;
      state.q = p.lateral;
      state.e_psi = angle(state.yaw - p.heading);
    }

    return state;
  }

  // Diagnostic helper functions
  beta(state) {
    return Math.atan2(state.v_y, Math.max(0.1, state.v_x));
  }

  speed(state) {
    return Math.hypot(state.v_x, state.v_y);
  }

  accelerations(state, cmd) {
    const d = this.derivatives(state, cmd);
    return { a_x: d.a_x, a_y: d.a_y };
  }
}

export function createTransientModel(options = {}) {
  const spec = options.spec ?? CAR_CLASSES.gt;
  const identification = options.identification ?? null;
  return new TransientModel(spec, identification, options);
}

export function loadTransientModel(spec = CAR_CLASSES.gt, artifactPath = null) {
  let identification = null;
  const targetPath = artifactPath ?? path.join(process.cwd(), 'artifacts', 'mrt-identification-v1.json');
  try {
    if (fs.existsSync(targetPath)) {
      identification = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    }
  } catch (err) {
    console.warn(`[TransientModel] Failed to load ${targetPath}:`, err.message);
  }
  return new TransientModel(spec, identification);
}
