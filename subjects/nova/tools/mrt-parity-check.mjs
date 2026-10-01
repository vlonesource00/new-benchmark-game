import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { TransientModel } from '../src/ai/model/transient-model.js';
import { CAR_CLASSES } from '../src/sim/car-specs.js';

const ident = JSON.parse(readFileSync('artifacts/mrt-identification-v1.json', 'utf8'));
const model = new TransientModel(CAR_CLASSES.gt, ident);

// Initial state
const state = model.init({
  x: 10.0,
  z: -5.0,
  yaw: 0.3,
  vx: 28.5,
  vy: -1.2,
  r: 0.25,
  delta: 0.05,
  fx: 2500.0,
});

const dt = 0.02;
const steps = 100;
const trajectory = [];

for (let i = 0; i < steps; i++) {
  // Dynamic control input
  const delta_cmd = 0.12 * Math.sin(i * 0.08) - 0.05;
  const F_x_cmd = 4000.0 * Math.cos(i * 0.05) - 1000.0;
  const cmd = { delta_cmd, F_x_cmd };

  trajectory.push({
    step: i,
    t: +(i * dt).toFixed(4),
    x: state.x,
    z: state.z,
    yaw: state.yaw,
    v_x: state.v_x,
    v_y: state.v_y,
    r: state.r,
    delta: state.delta,
    F_x: state.F_x,
    delta_cmd,
    F_x_cmd,
  });

  model.step(state, cmd, dt);
}

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/mrt-js-trajectory.json', JSON.stringify(trajectory, null, 2));
console.log('Saved JS trajectory with 100 steps to artifacts/mrt-js-trajectory.json');
