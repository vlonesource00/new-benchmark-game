import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Vehicle } from '../src/sim/vehicle.js';
import { CAR_CLASSES } from '../src/sim/car-specs.js';
import { TransientModel } from '../src/ai/model/transient-model.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HALF_LENGTH = 2.30;
const HALF_WIDTH = 0.99;
const G = 9.81;

export function getBodyCorners(x, z, yaw) {
  const sinY = Math.sin(yaw);
  const cosY = Math.cos(yaw);
  const uf_x = sinY, uf_z = cosY;
  const ur_x = cosY, ur_z = -sinY;

  return [
    [x + HALF_LENGTH * uf_x + HALF_WIDTH * ur_x, z + HALF_LENGTH * uf_z + HALF_WIDTH * ur_z],
    [x + HALF_LENGTH * uf_x - HALF_WIDTH * ur_x, z + HALF_LENGTH * uf_z - HALF_WIDTH * ur_z],
    [x - HALF_LENGTH * uf_x + HALF_WIDTH * ur_x, z - HALF_LENGTH * uf_z + HALF_WIDTH * ur_z],
    [x - HALF_LENGTH * uf_x - HALF_WIDTH * ur_x, z - HALF_LENGTH * uf_z - HALF_WIDTH * ur_z],
  ];
}

export function checkBodyLegality(taskId, x, z, yaw) {
  const corners = getBodyCorners(x, z, yaw);
  const margins = [];

  if (taskId === 'case_a_straight_accel' || taskId === 'case_b_straight_braking') {
    const w_half = 6.0;
    for (const c of corners) {
      margins.push(w_half - Math.abs(c[0]));
    }
  } else if (taskId === 'case_c_constant_circle') {
    const r_in = 70.0;
    const r_out = 90.0;
    for (const c of corners) {
      const r = Math.hypot(c[0], c[1]);
      margins.push(Math.min(r - r_in, r_out - r));
    }
  } else if (taskId === 'case_d_stadium') {
    for (const c of corners) {
      const cx = c[0], cz = c[1];
      if (cx < 0) {
        margins.push(7.0 - Math.abs(cz - (-50.0)));
      } else {
        const r = Math.hypot(cx, cz);
        margins.push(Math.min(r - 42.0, 58.0 - r));
      }
    }
  } else if (taskId === 'case_e_hairpin') {
    for (const c of corners) {
      const cx = c[0], cz = c[1];
      if (cz < 0) {
        margins.push(Math.min(cx - (-33.0), (-17.0) - cx));
      } else {
        const r = Math.hypot(cx, cz);
        margins.push(Math.min(r - 17.0, 33.0 - r));
      }
    }
  } else if (taskId === 'case_f_chicane' || taskId === 'case_g_sbend') {
    const w_half = 6.5;
    for (const c of corners) {
      const cx = c[0], cz = c[1];
      const xc = 4.0 * Math.sin(cz * Math.PI / 60.0);
      margins.push(w_half - Math.abs(cx - xc));
    }
  } else if (taskId === 'case_h_trail_brake') {
    for (const c of corners) {
      const cx = c[0], cz = c[1];
      if (cz < -10.0) {
        margins.push(7.0 - Math.abs(cx - (-30.0)));
      } else {
        const r = Math.hypot(cx - (-10.0), cz - (-10.0));
        margins.push(Math.min(r - 13.0, 27.0 - r));
      }
    }
  } else if (taskId === 'case_i_corner_exit') {
    for (const c of corners) {
      const cx = c[0], cz = c[1];
      if (cx > 20.0) {
        margins.push(7.0 - Math.abs(cz - 50.0));
      } else {
        const r = Math.hypot(cx, cz);
        margins.push(Math.min(r - 42.0, 58.0 - r));
      }
    }
  } else {
    for (const c of corners) {
      margins.push(10.0 - Math.abs(c[0]));
    }
  }

  return Math.min(...margins);
}

export function checkTerminalSatisfaction(taskId, terminalState) {
  const { x, z, yaw, vx, vy, speed } = terminalState;
  let satisfied = false;
  let minResidual = 0.0;

  if (taskId === 'case_a_straight_accel') {
    const resDist = z - 150.0;
    const resTrack = 6.0 - Math.abs(x);
    minResidual = Math.min(resDist, resTrack);
    satisfied = resDist >= -0.5 && resTrack >= 0.0;
  } else if (taskId === 'case_b_straight_braking') {
    const resDist = z - 100.0;
    const resSpeed = 18.0 - vx;
    const resTrack = 6.0 - Math.abs(x);
    minResidual = Math.min(resDist, resSpeed, resTrack);
    satisfied = resDist >= -0.5 && resSpeed >= -0.5 && resTrack >= 0.0;
  } else if (taskId === 'case_c_constant_circle') {
    const resX = x - 75.0;
    const resZ = 10.0 - z;
    const resSpeed = vx - 28.0;
    minResidual = Math.min(resX, resZ, resSpeed);
    satisfied = resX >= -1.0 && resZ >= -1.0 && resSpeed >= -1.0;
  } else if (taskId === 'case_d_stadium') {
    const resX = x - (-5.0);
    const resSpeed = 24.0 - vx;
    minResidual = Math.min(resX, resSpeed);
    satisfied = resX >= -1.0 && resSpeed >= -1.0;
  } else if (taskId === 'case_e_hairpin') {
    const resZ = z - 20.0;
    const resYaw = yaw - 0.75;
    const resSpeed = vx - 16.0;
    minResidual = Math.min(resZ, resYaw * 10.0, resSpeed);
    satisfied = resZ >= -1.0 && resYaw >= -0.1 && resSpeed >= -1.0;
  } else if (taskId === 'case_f_chicane') {
    const resZ = z - 15.0;
    const resSpeed = vx - 30.0;
    minResidual = Math.min(resZ, resSpeed);
    satisfied = resZ >= -1.0 && resSpeed >= -1.0;
  } else if (taskId === 'case_g_sbend') {
    const resZ = z - 0.0;
    const resSpeed = vx - 32.0;
    minResidual = Math.min(resZ, resSpeed);
    satisfied = resZ >= -1.0 && resSpeed >= -1.0;
  } else if (taskId === 'case_h_trail_brake') {
    const resZ = z - (-5.0);
    const resSpeed = 24.0 - vx;
    minResidual = Math.min(resZ, resSpeed);
    satisfied = resZ >= -1.0 && resSpeed >= -1.0;
  } else if (taskId === 'case_i_corner_exit') {
    const resX = x - 45.0;
    const resSpeed = vx - 32.0;
    minResidual = Math.min(resX, resSpeed);
    satisfied = resX >= -1.0 && resSpeed >= -1.0;
  } else {
    satisfied = true;
    minResidual = 0.0;
  }

  return { satisfied, minResidual };
}

export function replayCanonicalVehicle(task, solution) {
  const taskId = task.id;
  const start = task.start;
  const nodes = solution.nodes;
  const T = solution.final_T;
  const N = solution.N || (nodes.length - 1);
  const dtOracle = solution.dt || (T / N);

  const vehicle = new Vehicle(0, 'ORACLE_REPLAY', '#ffffff', 'gt');
  const SPEC = vehicle.spec;

  vehicle.resetState();
  vehicle.x = start[0];
  vehicle.z = start[1];
  vehicle.yaw = start[2];
  vehicle.yawRate = start[5];
  vehicle.steering = start[6];

  const v_x = start[3];
  const v_y = start[4];
  const sinY = Math.sin(vehicle.yaw);
  const cosY = Math.cos(vehicle.yaw);

  vehicle.vx = sinY * v_x + cosY * v_y;
  vehicle.vz = cosY * v_x - sinY * v_y;
  vehicle.u = v_x;
  vehicle.v = v_y;
  vehicle.speed = Math.hypot(v_x, v_y);

  vehicle.wheels.forEach(w => {
    w.omega = Math.max(0.1, v_x) / SPEC.radius;
  });

  for (let g = 1; g <= 6; g++) {
    const ratio = SPEC.gears[g] * SPEC.finalDrive;
    const rpm = (Math.abs(v_x) / SPEC.radius) * ratio * 9.5493;
    if (rpm >= 2800 && rpm <= 7400) {
      vehicle.gear = g;
      vehicle.rpm = rpm;
      break;
    }
  }

  const syntheticTrack = {
    surface(wx, wz) {
      return {
        x: wx, z: wz, s: 0, lateral: 0, zone: 'asphalt',
        grip: 1.0,
        bump: 0,
        resistance: 0.013,
        tx: 0, tz: 1, nx: 1, nz: 0, heading: 0, curvature: 0, index: 0
      };
    },
    deposit(surface, slipPower, load, dt) {}
  };

  const dtPlant = 1.0 / 120.0;
  const totalSteps = Math.ceil(T / dtPlant);
  let maxLongG = 0.0;
  let maxLatG = 0.0;
  let minBodyMargin = Infinity;
  let spun = false;
  let offtrack = false;

  const trajectory = [];

  for (let step = 0; step < totalSteps; step++) {
    const t = step * dtPlant;

    const nodeIdx = Math.min(N - 1, Math.floor(t / dtOracle));
    const nextIdx = Math.min(N - 1, nodeIdx + 1);
    const alpha = Math.min(1.0, Math.max(0.0, (t - nodeIdx * dtOracle) / dtOracle));

    const currNode = nodes[nodeIdx];
    const nextNode = nodes[nextIdx];

    let steerCmd = 0.0;
    let throttleCmd = 0.0;
    let brakeCmd = 0.0;

    if ('steer' in currNode && 'throttle' in currNode && 'brake' in currNode) {
      steerCmd = (1 - alpha) * currNode.steer + alpha * nextNode.steer;
      throttleCmd = (1 - alpha) * currNode.throttle + alpha * nextNode.throttle;
      brakeCmd = (1 - alpha) * currNode.brake + alpha * nextNode.brake;
    } else {
      const deltaCmd = (1 - alpha) * currNode.delta_cmd + alpha * nextNode.delta_cmd;
      steerCmd = deltaCmd / SPEC.steeringLock;
      const FxCmd = (1 - alpha) * currNode.F_x_cmd + alpha * nextNode.F_x_cmd;
      if (FxCmd >= 0) {
        throttleCmd = Math.min(1.0, FxCmd / 8000.0);
        brakeCmd = 0.0;
      } else {
        throttleCmd = 0.0;
        brakeCmd = Math.min(1.0, -FxCmd / 18000.0);
      }
    }

    vehicle.controls.steer = Math.max(-1.0, Math.min(1.0, steerCmd));
    vehicle.controls.throttle = Math.max(0.0, Math.min(1.0, throttleCmd));
    vehicle.controls.brake = Math.max(0.0, Math.min(1.0, brakeCmd));

    vehicle.step(dtPlant, syntheticTrack, 0);

    const ax_g = Math.abs(vehicle.ax) / G;
    const ay_g = Math.abs(vehicle.ay) / G;
    maxLongG = Math.max(maxLongG, ax_g);
    maxLatG = Math.max(maxLatG, ay_g);

    const margin = checkBodyLegality(taskId, vehicle.x, vehicle.z, vehicle.yaw);
    minBodyMargin = Math.min(minBodyMargin, margin);
    if (margin < 0) {
      offtrack = true;
    }

    const beta = Math.atan2(vehicle.v, Math.max(1.0, vehicle.u));
    if (Math.abs(beta) > 0.65 || Math.abs(vehicle.yawRate) > 3.0) {
      spun = true;
    }

    if (step % 12 === 0 || step === totalSteps - 1) {
      trajectory.push({
        t: parseFloat(t.toFixed(4)),
        x: parseFloat(vehicle.x.toFixed(4)),
        z: parseFloat(vehicle.z.toFixed(4)),
        yaw: parseFloat(vehicle.yaw.toFixed(4)),
        vx: parseFloat(vehicle.u.toFixed(4)),
        vy: parseFloat(vehicle.v.toFixed(4)),
        yawRate: parseFloat(vehicle.yawRate.toFixed(4)),
        ax_g: parseFloat(ax_g.toFixed(3)),
        ay_g: parseFloat(ay_g.toFixed(3)),
        margin: parseFloat(margin.toFixed(3)),
      });
    }
  }

  const oracleTerm = nodes[nodes.length - 1];
  const termPosErr = Math.hypot(vehicle.x - oracleTerm.x, vehicle.z - oracleTerm.z);
  const termSpeedErr = Math.abs(vehicle.u - oracleTerm.v_x);
  const termYawErr = Math.abs(vehicle.yaw - oracleTerm.yaw);

  const termState = {
    x: vehicle.x,
    z: vehicle.z,
    yaw: vehicle.yaw,
    vx: vehicle.u,
    vy: vehicle.v,
    yawRate: vehicle.yawRate,
    speed: vehicle.speed
  };

  const termSat = checkTerminalSatisfaction(taskId, termState);

  const status = termSat.satisfied && !spun && !offtrack && maxLongG <= 2.05 && maxLatG <= 2.25
    ? 'CANONICAL_PLANT_CERTIFIED'
    : (termSat.satisfied ? 'CANONICAL_PLANT_SATISFIED' : 'CANONICAL_PLANT_DEVIATED');

  return {
    taskId,
    status,
    final_time: T,
    plant_dt: dtPlant,
    total_steps: totalSteps,
    terminal_error_pos_m: parseFloat(termPosErr.toFixed(4)),
    terminal_error_speed_mps: parseFloat(termSpeedErr.toFixed(4)),
    terminal_error_yaw_rad: parseFloat(termYawErr.toFixed(4)),
    terminal_satisfied: termSat.satisfied,
    terminal_residual_min: parseFloat(termSat.minResidual.toFixed(4)),
    max_longitudinal_g: parseFloat(maxLongG.toFixed(3)),
    max_lateral_g: parseFloat(maxLatG.toFixed(3)),
    min_body_margin_m: parseFloat(minBodyMargin.toFixed(3)),
    body_legal: minBodyMargin >= 0.0,
    spun,
    offtrack,
    trajectory_sample_count: trajectory.length
  };
}

export function replayTransientModel(task, solution) {
  const ident = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../artifacts/mrt-identification-v1.json'), 'utf8'));
  const model = new TransientModel(CAR_CLASSES.gt, ident);
  const start = task.start;
  const nodes = solution.nodes;
  const N = nodes.length - 1;
  const dt = solution.dt || (solution.final_T / N);

  const state = model.init({
    x: start[0],
    z: start[1],
    yaw: start[2],
    vx: start[3],
    vy: start[4],
    r: start[5],
    delta: start[6],
    fx: start[7],
  });

  for (let k = 0; k < N; k++) {
    const node = nodes[k];
    const cmd = {
      steer: node.steer,
      throttle: node.throttle,
      brake: node.brake,
      delta_cmd: node.delta_cmd,
      F_x_cmd: node.F_x_cmd
    };
    model.step(state, cmd, dt);
  }

  const oracleTerm = nodes[N];
  const termPosErr = Math.hypot(state.x - oracleTerm.x, state.z - oracleTerm.z);
  const termSpeedErr = Math.abs(state.v_x - oracleTerm.v_x);
  const termYawErr = Math.abs(state.yaw - oracleTerm.yaw);

  return {
    terminal_error_pos_m: parseFloat(termPosErr.toExponential(4)),
    terminal_error_speed_mps: parseFloat(termSpeedErr.toExponential(4)),
    terminal_error_yaw_rad: parseFloat(termYawErr.toExponential(4)),
    terminal_match: termPosErr < 1e-4 && termSpeedErr < 1e-4
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node tools/canonical-plant-replay.mjs <solution_json_path>');
    process.exit(1);
  }
  const inputPath = path.resolve(args[0]);
  const inputData = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  if (inputData.tasks) {
    const results = {};
    for (const [taskId, taskData] of Object.entries(inputData.tasks)) {
      const bestMeshSol = taskData.solutions_by_mesh?.N_80 || taskData.solutions_by_mesh?.N_40;
      if (bestMeshSol && taskData.start) {
        results[taskId] = {
          js_mrt_replay: replayTransientModel(taskData, bestMeshSol),
          canonical_plant: replayCanonicalVehicle(taskData, bestMeshSol)
        };
      }
    }
    console.log(JSON.stringify(results, null, 2));
  } else if (inputData.task && inputData.solution) {
    const jsMrt = replayTransientModel(inputData.task, inputData.solution);
    const plant = replayCanonicalVehicle(inputData.task, inputData.solution);
    console.log(JSON.stringify({ js_mrt_replay: jsMrt, canonical_plant: plant }, null, 2));
  } else {
    console.error('Unrecognized input JSON structure');
    process.exit(1);
  }
}
