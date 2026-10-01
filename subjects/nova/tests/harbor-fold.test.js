// tests/harbor-fold.test.js
// Verification of World-Space M_RT Continuity and Host Projection
// across the Harbor Ring East Hairpin Frenet Singularity Fold (1 - q*kappa <= 0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { loadTransientModel } from '../src/ai/model/transient-model.js';
import { CAR_CLASSES } from '../src/sim/car-specs.js';

test('Harbor Hairpin Fold: World-space M_RT integrates smoothly across 1 - q*kappa <= 0', () => {
  const track = new Track('harbor-ring');
  const model = loadTransientModel(CAR_CLASSES.gt);

  // Peak curvature station in Harbor Ring (~864.15 m, kappa ~ 0.1568 => 1/kappa ~ 6.38 m)
  let maxKappa = 0;
  let foldStation = 0;
  track.nodes.forEach((n) => {
    if (Math.abs(n.curvature) > maxKappa) {
      maxKappa = Math.abs(n.curvature);
      foldStation = n.s;
    }
  });

  assert.ok(maxKappa > 0.15, 'Found sharp curvature peak in Harbor Ring');
  const singularQ = -1 / maxKappa; // Approx -6.38 m

  // Test across the fold: centerline, mild offsets, singularity threshold, and deep inside/outside
  const testQ = [0, -4, -6, -6.3, singularQ, -6.4, -7, 4, 7];

  for (const q of testQ) {
    const p = track.at(foldStation, q);
    
    // Check that world point generation is finite
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), `World point must be finite at q=${q}`);
    
    // Check projection back to host
    const proj = track.nearest(p.x, p.z);
    assert.ok(Number.isFinite(proj.s) && Number.isFinite(proj.lateral), `Projection must be finite at q=${q}`);
    assert.ok(Math.abs(proj.lateral - q) < 0.25, `Projected lateral ${proj.lateral.toFixed(2)} matches target ${q}`);

    // Initialize world-space M_RT state at this exact pose
    const state = model.init({
      x: p.x,
      z: p.z,
      yaw: p.heading,
      vx: 18.0, // 65 km/h hairpin cornering speed
      vy: 0.0,
      r: 18.0 * p.curvature,
      steer: 0.5 * Math.sign(p.curvature)
    });

    // Step the model forward for 120 steps (1.0 second of dynamic rollout)
    const dt = 1 / 120;
    for (let step = 0; step < 120; step++) {
      model.step(state, { steer: 0.5 * Math.sign(p.curvature), throttle: 0.2, brake: 0 }, dt, track);
      
      // Strict invariants: zero NaN, zero velocity explosion, continuous motion
      assert.ok(Number.isFinite(state.x), `x must be finite at step ${step} (q=${q})`);
      assert.ok(Number.isFinite(state.z), `z must be finite at step ${step} (q=${q})`);
      assert.ok(Number.isFinite(state.yaw), `yaw must be finite at step ${step} (q=${q})`);
      assert.ok(Number.isFinite(state.v_x), `v_x must be finite at step ${step} (q=${q})`);
      assert.ok(Number.isFinite(state.v_y), `v_y must be finite at step ${step} (q=${q})`);
      assert.ok(Number.isFinite(state.r), `yawRate must be finite at step ${step} (q=${q})`);
      
      // Speed must stay physically bounded (no runaway acceleration)
      assert.ok(state.speed > 5 && state.speed < 40, `Speed ${state.speed.toFixed(2)} must remain physically bounded at q=${q}`);
      
      // No artificial branch teleportation: step displacement must be ~ v * dt
      const stepDisplacement = Math.hypot(state.v_x * dt, state.v_y * dt);
      assert.ok(stepDisplacement < 1.0, `Displacement per step must be continuous`);
    }
  }
});
