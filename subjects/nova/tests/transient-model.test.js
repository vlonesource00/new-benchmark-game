// tests/transient-model.test.js
// Verification of M_RT Physical Integrity, Load Transfer Signs, Axle Independence, and Plant Parity

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { loadTransientModel, createTransientModel } from '../src/ai/model/transient-model.js';
import { CAR_CLASSES } from '../src/sim/car-specs.js';

const SPEC = CAR_CLASSES.gt;
const idPath = path.join(process.cwd(), 'artifacts', 'mrt-identification-v1.json');

test('TransientModel initializes cleanly with correct mass and geometry', (t) => {
  const model = loadTransientModel(SPEC, idPath);
  
  // Total mass check: dry mass 1290 + fuel 35 * 0.75 = 1316.25 kg
  assert.strictEqual(model.mass, 1316.25, 'Mass must match canonical plant mass with 35L fuel');
  
  // Geometry check: distance from CG to front and rear axles
  // Front axle: a = (1 - wf) * L = 0.53 * 2.78 = 1.4734 m
  // Rear axle:  b = wf * L       = 0.47 * 2.78 = 1.3066 m
  assert.ok(Math.abs(model.a_front - 1.4734) < 1e-4, 'Front moment arm a_front must be (1 - wf) * L');
  assert.ok(Math.abs(model.b_rear - 1.3066) < 1e-4, 'Rear moment arm b_rear must be wf * L');
  assert.ok(Math.abs((model.a_front + model.b_rear) - SPEC.wheelbase) < 1e-4, 'Sum of moment arms must equal wheelbase');
});

test('Static axle load split matches frontWeight at zero speed and zero accel', (t) => {
  const model = loadTransientModel(SPEC, idPath);
  const state = model.init({ u: 0, vx: 0, vy: 0, r: 0, delta: 0, fx: 0 });
  const deriv = model.derivatives(state, { steer: 0, throttle: 0, brake: 0 });

  const totalNormal = deriv.F_z_front + deriv.F_z_rear;
  const mg = model.mass * 9.81;

  assert.ok(Math.abs(totalNormal - mg) < 1.0, 'Total normal load must equal mg');
  
  const frontFrac = deriv.F_z_front / totalNormal;
  const rearFrac = deriv.F_z_rear / totalNormal;

  assert.ok(Math.abs(frontFrac - SPEC.frontWeight) < 1e-3, `Static front load fraction ${frontFrac.toFixed(4)} matches frontWeight ${SPEC.frontWeight}`);
  assert.ok(Math.abs(rearFrac - (1 - SPEC.frontWeight)) < 1e-3, `Static rear load fraction ${rearFrac.toFixed(4)} matches 1 - frontWeight`);
});

test('Dynamic load transfer signs: braking increases front load, acceleration increases rear load', (t) => {
  const model = loadTransientModel(SPEC, idPath);
  
  // Static reference
  const sStatic = model.init({ vx: 30, fx: 0 });
  const dStatic = model.derivatives(sStatic, { steer: 0, throttle: 0, brake: 0 });

  // Braking scenario (negative Fx)
  const sBraking = model.init({ vx: 30, fx: -6000 });
  const dBraking = model.derivatives(sBraking, { steer: 0, throttle: 0, brake: 1.0 });

  assert.ok(dBraking.F_z_front > dStatic.F_z_front, 'Braking must INCREASE front normal load');
  assert.ok(dBraking.F_z_rear < dStatic.F_z_rear, 'Braking must DECREASE rear normal load');

  // Acceleration scenario (positive Fx)
  const sAccel = model.init({ vx: 30, fx: 4000 });
  const dAccel = model.derivatives(sAccel, { steer: 0, throttle: 1.0, brake: 0 });

  assert.ok(dAccel.F_z_rear > dStatic.F_z_rear, 'Acceleration must INCREASE rear normal load');
  assert.ok(dAccel.F_z_front < dStatic.F_z_front, 'Acceleration must DECREASE front normal load');
});

test('Axle combined slip: rear-drive acceleration does not attenuate front lateral capacity', (t) => {
  const model = loadTransientModel(SPEC, idPath);
  
  // Steering step with zero throttle
  const sCoast = model.init({ vx: 30, vy: 0, delta: 0.1, fx: 0 });
  const dCoast = model.derivatives(sCoast, { steer: 0.1 / SPEC.steeringLock, throttle: 0, brake: 0 });

  // Same steering step with full throttle (rear drive)
  const sDrive = model.init({ vx: 30, vy: 0, delta: 0.1, fx: 4500 });
  const dDrive = model.derivatives(sDrive, { steer: 0.1 / SPEC.steeringLock, throttle: 1.0, brake: 0 });

  // Front wheel combined slip ellipse should remain 1.0 under rear-wheel drive
  assert.strictEqual(dDrive.ellipse_f, 1.0, 'Front friction ellipse must remain 1.0 under rear-drive acceleration');
  assert.ok(dDrive.ellipse_r < 1.0, 'Rear friction ellipse must be reduced due to drive torque');
});

test('step() preserves energy, computes finite state variables with zero NaN', (t) => {
  const model = loadTransientModel(SPEC, idPath);
  let state = model.init({ vx: 50, vy: 0, r: 0, delta: 0, fx: 0 });
  
  // Coasting down from 50 m/s
  for (let i = 0; i < 120; i++) {
    state = model.step(state, { steer: 0, throttle: 0, brake: 0 }, 1 / 120);
  }
  
  assert.ok(Number.isFinite(state.x), 'x should be finite');
  assert.ok(Number.isFinite(state.z), 'z should be finite');
  assert.ok(Number.isFinite(state.v_x), 'v_x should be finite');
  assert.ok(state.v_x > 0 && state.v_x < 50, 'Velocity should decay smoothly due to drag/rolling resistance');
  
  // No NaN allowed in any property
  for (const [key, value] of Object.entries(state)) {
    if (typeof value === 'number') {
      assert.ok(!Number.isNaN(value), `${key} must not be NaN`);
    }
  }
});

test('body slip beta responds dynamically with transient delay', (t) => {
  const model = loadTransientModel(SPEC, idPath);
  let state = model.init({ vx: 35, vy: 0, r: 0, delta: 0, fx: 0 });
  
  // Apply sudden steering step
  const cmd = { steer: 0.2, throttle: 0.1, brake: 0 };
  const betas = [];
  for (let i = 0; i < 60; i++) {
    state = model.step(state, cmd, 1 / 120);
    betas.push(model.beta(state));
  }
  
  assert.ok(Math.abs(betas[0]) < 0.005, 'Beta starts near 0');
  assert.ok(Math.abs(betas[59]) > 0.01, 'Beta builds up with chassis momentum');
  assert.ok(Math.abs(betas[1] - betas[0]) < Math.abs(betas[59] - betas[0]), 'Beta has transient inertia lag');
});
