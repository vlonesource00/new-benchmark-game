import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AIDebugger } from '../src/render/debugger.js';

test('AIDebugger initializes Three.js hierarchy and toggles visibility cleanly', () => {
  const scene = new THREE.Scene();
  const mockCar = {
    name: 'TEST CAR',
    classId: 'gt',
    speed: 25.0,
    s: 120.0,
    lateral: 0.5,
    x: 10.0,
    y: 0.0,
    z: 20.0,
    ay: 9.81 * 1.1,
    ax: 2.5,
    controls: { throttle: 0.8, brake: 0.0, steer: 0.05 },
    race: { lastLap: 85.2, bestLap: 84.8 },
  };
  const mockDriver = {
    state: {
      intent: 'PACE',
      mode: 'PACE',
      cause: 'FREE_AIR',
      targetSpeed: 28.0,
      rlat: 0.12,
      rhead: 0.02,
      plannedBrake: false,
    },
    ai: {
      local: {
        path: {
          n: 16,
          px: new Float64Array(16).fill(10),
          pz: new Float64Array(16).map((_, i) => i * 2),
        },
        profile: {
          v: new Float64Array(16).fill(25),
        },
      },
    },
  };
  const mockSession = {
    cars: [mockCar],
    drivers: [mockDriver],
    player: mockCar,
    activeCars: [mockCar],
    lineFor: () => null,
  };

  const dbg = new AIDebugger(scene, mockSession);
  assert.equal(dbg.enabled, false);
  assert.equal(dbg.root.visible, false);

  // Toggle on
  const state = dbg.toggle(true);
  assert.equal(state, true);
  assert.equal(dbg.enabled, true);
  assert.equal(dbg.root.visible, true);

  // Update step
  dbg.update(120);

  // Toggle off
  dbg.toggle(false);
  assert.equal(dbg.enabled, false);
  assert.equal(dbg.root.visible, false);
});
