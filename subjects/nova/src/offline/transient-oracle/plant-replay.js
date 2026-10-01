// src/offline/transient-oracle/plant-replay.js
// Verification of Open-Loop Transferability of M_RT Optimal Controls to the Canonical Plant

import { Vehicle } from '../../sim/vehicle.js';
import { angle, clamp, lerp } from '../../sim/math.js';

export class PlantReplayEngine {
  constructor(model, track = null) {
    this.model = model;
    this.track = track;
    this.spec = model.spec;
  }

  /**
   * Replays an open-loop control sequence through both M_RT and the canonical Vehicle plant.
   * 
   * @param {Object} solution Oracle solution containing trajectory and controls
   * @param {Track} track Track environment
   * @returns {Object} Plant replay audit metrics
   */
  replay(solution, track) {
    const DT = 1 / 120;
    const initial = solution.trajectory[0];
    const totalTime = solution.objectiveTime;
    const nSteps = Math.round(totalTime / DT);

    // 1. Initialize Canonical Vehicle Plant
    const plant = new Vehicle(0, 'ORACLE_REPLAY', '#fff', 'gt');
    plant.x = initial.x;
    plant.z = initial.z;
    plant.yaw = initial.yaw;
    plant.vx = initial.v_x * Math.sin(initial.yaw) + initial.v_y * Math.cos(initial.yaw);
    plant.vz = initial.v_x * Math.cos(initial.yaw) - initial.v_y * Math.sin(initial.yaw);
    plant.speed = initial.speed;
    plant.u = initial.v_x;
    plant.v = initial.v_y;
    plant.steering = initial.delta;
    plant.yawRate = initial.r;

    // 2. Initialize M_RT verification instance
    const mrt = this.model.init({
      x: initial.x,
      z: initial.z,
      yaw: initial.yaw,
      vx: initial.v_x,
      vy: initial.v_y,
      r: initial.r,
      delta: initial.delta,
      fx: initial.F_x
    });

    const plantTrajectory = [];
    const mrtTrajectory = [];
    const deviations = [];

    // Continuous time series replay
    for (let step = 0; step < nSteps; step++) {
      const t = step * DT;
      
      // Smoothly interpolate control input at time t
      const prog = t / solution.dt;
      const i0 = Math.min(solution.controls.length - 1, Math.floor(prog));
      const i1 = Math.min(solution.controls.length - 1, i0 + 1);
      const frac = clamp(prog - i0, 0, 1);

      const c0 = solution.controls[i0] || { steer: 0, throttle: 0, brake: 0 };
      const c1 = solution.controls[i1] || c0;

      const steerVal = clamp(lerp(c0.steer, c1.steer, frac), -1, 1);
      const throttleVal = clamp(lerp(c0.throttle, c1.throttle, frac), 0, 1);
      const brakeVal = clamp(lerp(c0.brake, c1.brake, frac), 0, 1);

      const appliedCmd = { steer: steerVal, throttle: throttleVal, brake: brakeVal };
      plant.controls = appliedCmd;
      plant.step(DT, track, 0);

      // Apply controls to M_RT
      this.model.step(mrt, appliedCmd, DT, track);

      // Measure instantaneous deviation
      const dev = Math.hypot(plant.x - mrt.x, plant.z - mrt.z);
      deviations.push(dev);

      if (step % 4 === 0) {
        plantTrajectory.push({ t: +t.toFixed(3), x: +plant.x.toFixed(3), z: +plant.z.toFixed(3), speed: +plant.speed.toFixed(2) });
        mrtTrajectory.push({ t: +t.toFixed(3), x: +mrt.x.toFixed(3), z: +mrt.z.toFixed(3), speed: +mrt.speed.toFixed(2) });
      }
    }

    const lastOracle = solution.trajectory[solution.trajectory.length - 1];
    const terminalPosErr = Math.hypot(plant.x - lastOracle.x, plant.z - lastOracle.z);
    const terminalSpeedErr = Math.abs(plant.speed - lastOracle.speed);
    const terminalYawErr = Math.abs(angle(plant.yaw - lastOracle.yaw));

    const meanDeviation = deviations.reduce((a, b) => a + b, 0) / Math.max(1, deviations.length);
    const maxDeviation = Math.max(...deviations);

    return {
      terminalPosErr: +terminalPosErr.toFixed(3),
      terminalSpeedErr: +terminalSpeedErr.toFixed(3),
      terminalYawErr: +terminalYawErr.toFixed(4),
      meanDeviation: +meanDeviation.toFixed(3),
      maxDeviation: +maxDeviation.toFixed(3),
      totalReplayTime: +(nSteps * DT).toFixed(3),
      status: (terminalPosErr <= 3.0 || meanDeviation <= 2.0) ? 'VALIDATED_ON_PLANT' : 'DISCREPANCY_FLAGGED'
    };
  }
}
