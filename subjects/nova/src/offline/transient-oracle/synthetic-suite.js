// src/offline/transient-oracle/synthetic-suite.js
// Definitions for the 9 Canonical Synthetic Benchmark Problems for Checkpoint 3

import { Track } from '../../sim/track.js';

function createStraightTrack(length = 2000, halfWidth = 10) {
  const pts = [];
  for (let z = -length / 2; z <= length / 2; z += 100) {
    pts.push({ x: 0, y: 0, z });
  }
  return new Track({
    id: `synth-straight-${length}`,
    name: `Synthetic Straight ${length}m`,
    controlPoints: pts,
    sampleDensity: 20,
    roadHalfWidth: halfWidth,
    curbWidth: 1,
    runoffWidth: 15,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 0 }
  });
}

function createCircleTrack(R = 80, halfWidth = 12) {
  const pts = [];
  const n = 128;
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    pts.push({ x: R * Math.sin(th), y: 0, z: R * Math.cos(th) });
  }
  return new Track({
    id: `synth-circle-${R}`,
    name: `Synthetic Circle R=${R}m`,
    controlPoints: pts,
    sampleDensity: 10,
    roadHalfWidth: halfWidth,
    curbWidth: 1,
    runoffWidth: 15,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 0 }
  });
}

function createStadiumTrack(straightLen = 300, R = 60, halfWidth = 10) {
  const pts = [];
  // South straight (z = -R, x from -straightLen/2 to straightLen/2)
  for (let x = -straightLen / 2; x <= straightLen / 2; x += 50) pts.push({ x, y: 0, z: -R });
  // East turn (semicircle)
  for (let i = 1; i < 16; i++) {
    const th = -Math.PI / 2 + (i / 16) * Math.PI;
    pts.push({ x: straightLen / 2 + R * Math.cos(th), y: 0, z: R * Math.sin(th) });
  }
  // North straight (z = R, x from straightLen/2 to -straightLen/2)
  for (let x = straightLen / 2; x >= -straightLen / 2; x -= 50) pts.push({ x, y: 0, z: R });
  // West turn (semicircle)
  for (let i = 1; i < 16; i++) {
    const th = Math.PI / 2 + (i / 16) * Math.PI;
    pts.push({ x: -straightLen / 2 + R * Math.cos(th), y: 0, z: R * Math.sin(th) });
  }
  return new Track({
    id: 'synth-stadium',
    name: 'Synthetic Stadium Track',
    controlPoints: pts,
    sampleDensity: 15,
    roadHalfWidth: halfWidth,
    curbWidth: 1,
    runoffWidth: 15,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 0 }
  });
}

function createChicaneTrack(halfWidth = 12) {
  const pts = [
    { x: 0, y: 0, z: -200 },
    { x: 0, y: 0, z: -60 },
    { x: 5, y: 0, z: -10 },
    { x: -5, y: 0, z: 40 },
    { x: 0, y: 0, z: 90 },
    { x: 0, y: 0, z: 250 }
  ];
  return new Track({
    id: 'synth-chicane',
    name: 'Synthetic Chicane Track',
    controlPoints: pts,
    sampleDensity: 20,
    roadHalfWidth: halfWidth,
    curbWidth: 1,
    runoffWidth: 15,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 0 }
  });
}

function createHairpinTrack(R = 25, halfWidth = 12) {
  const pts = [
    { x: -R, y: 0, z: -100 },
    { x: -R, y: 0, z: -50 },
    { x: -R, y: 0, z: 0 },
    { x: -R * Math.cos(Math.PI / 4), y: 0, z: R * Math.sin(Math.PI / 4) },
    { x: 0, y: 0, z: R },
    { x: R * Math.cos(Math.PI / 4), y: 0, z: R * Math.sin(Math.PI / 4) },
    { x: R, y: 0, z: 0 },
    { x: R, y: 0, z: -50 },
    { x: R, y: 0, z: -100 },
    { x: 0, y: 0, z: -120 }
  ];
  return new Track({
    id: `synth-hairpin-${R}`,
    name: `Synthetic Hairpin R=${R}m`,
    controlPoints: pts,
    sampleDensity: 15,
    roadHalfWidth: halfWidth,
    curbWidth: 1,
    runoffWidth: 12,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 0 }
  });
}

function createTrailBrakeTrack(R = 30, halfWidth = 12) {
  const pts = [
    { x: -R, y: 0, z: -100 },
    { x: -R, y: 0, z: -50 },
    { x: -R, y: 0, z: 0 },
    { x: -R * Math.cos(Math.PI / 4), y: 0, z: R * Math.sin(Math.PI / 4) },
    { x: 0, y: 0, z: R },
    { x: 50, y: 0, z: R },
    { x: 100, y: 0, z: R },
    { x: 50, y: 0, z: -100 }
  ];
  return new Track({
    id: `synth-trail-brake-${R}`,
    name: `Synthetic Trail Brake R=${R}m`,
    controlPoints: pts,
    sampleDensity: 15,
    roadHalfWidth: halfWidth,
    curbWidth: 1,
    runoffWidth: 12,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 0 }
  });
}

function createCornerExitTrack(R = 50, halfWidth = 12) {
  const pts = [
    { x: -R, y: 0, z: 0 },
    { x: 0, y: 0, z: R },
    { x: 50, y: 0, z: R },
    { x: 100, y: 0, z: R },
    { x: 150, y: 0, z: R },
    { x: 100, y: 0, z: -R },
    { x: 0, y: 0, z: -R }
  ];
  return new Track({
    id: `synth-corner-exit-${R}`,
    name: `Synthetic Corner Exit R=${R}m`,
    controlPoints: pts,
    sampleDensity: 15,
    roadHalfWidth: halfWidth,
    curbWidth: 1,
    runoffWidth: 12,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 0 }
  });
}

export const SYNTHETIC_SUITE = [
  // Problem A: Straight Acceleration (10 -> 35 m/s)
  {
    id: 'case_a_straight_accel',
    name: 'A. Straight Acceleration',
    description: 'Maximal open-loop longitudinal power rollout from 10 to 35 m/s',
    track: createStraightTrack(1200),
    periodic: false,
    horizonSec: 2.50,
    start: { x: 0, z: 0, yaw: 0, vx: 10.0, vy: 0, r: 0, delta: 0, fx: 0 },
    target: { v_x: 35.0 },
    guessGenerator: (k, N, T = 2.5) => {
      const u = k / N;
      const v = 10 + 25 * u;
      return {
        state: { x: 0, z: 10 * u * T + 0.5 * 10 * Math.pow(u * T, 2), yaw: 0, vx: v, vy: 0, r: 0, delta: 0, fx: 4500 },
        control: { steer: 0, throttle: 1.0, brake: 0 }
      };
    }
  },

  // Problem B: Straight Braking to Terminal Speed (55 -> 18 m/s)
  {
    id: 'case_b_straight_braking',
    name: 'B. Straight Braking to Terminal Speed',
    description: 'High-speed threshold braking from 55 m/s down to 18 m/s terminal entry',
    track: createStraightTrack(800),
    periodic: false,
    horizonSec: 2.10,
    start: { x: 0, z: 0, yaw: 0, vx: 55.0, vy: 0, r: 0, delta: 0, fx: 0 },
    target: { v_x: 18.0 },
    guessGenerator: (k, N, T = 2.1) => {
      const u = k / N;
      const v = 55 - 37 * u;
      return {
        state: { x: 0, z: 55 * u * T - 0.5 * 17.6 * Math.pow(u * T, 2), yaw: 0, vx: v, vy: 0, r: 0, delta: 0, fx: -16000 },
        control: { steer: 0, throttle: 0, brake: 0.85 }
      };
    }
  },

  // Problem C: Constant-Radius Circle (R = 80 m)
  {
    id: 'case_c_constant_circle',
    name: 'C. Constant-Radius Circle',
    description: 'Max steady-state achievable cornering speed and arc traversal on R=80m skidpad',
    track: createCircleTrack(80, 14),
    periodic: false,
    horizonSec: 3.86,
    start: { x: 0, z: 80, yaw: Math.PI / 2, vx: 32.5, vy: 0, r: 32.5 / 80, delta: 0.068, fx: 1200 },
    target: { v_x: 32.5 },
    guessGenerator: (k, N, T = 3.86) => {
      const u = k / N;
      const th = u * (Math.PI / 2);
      const steerLock = 0.48;
      const steerCmd = 0.068 / steerLock;
      return {
        state: { x: 80 * Math.sin(th), z: 80 * Math.cos(th), yaw: th + Math.PI / 2, vx: 32.5, vy: 0, r: 32.5 / 80, delta: 0.068, fx: 1200 },
        control: { steer: steerCmd, throttle: 0.28, brake: 0 }
      };
    }
  },

  // Problem D: Stadium Loop
  {
    id: 'case_d_stadium',
    name: 'D. Stadium Loop',
    description: 'Straight deceleration into R=50m turn entry balancing straightaway speed with turn-in',
    track: createStadiumTrack(200, 50, 14),
    periodic: false,
    horizonSec: 2.00,
    start: { x: -60, z: -50, yaw: Math.PI / 2, vx: 42.0, vy: 0, r: 0, delta: 0, fx: 0 },
    target: { v_x: 22.0 },
    guessGenerator: (k, N, T = 2.0) => {
      const u = k / N;
      const v = 42 - 20 * u;
      return {
        state: { x: -60 + 42 * u * T - 0.5 * 10 * Math.pow(u * T, 2), z: -50, yaw: Math.PI / 2, vx: v, vy: 0, r: 0, delta: 0, fx: -4500 },
        control: { steer: 0, throttle: 0.15, brake: 0.35 }
      };
    }
  },

  // Problem E: Single Hairpin (R = 25 m)
  {
    id: 'case_e_hairpin',
    name: 'E. Single Hairpin',
    description: '180-degree hairpin turn testing entry trail braking, yaw rotation, and corner exit',
    track: createHairpinTrack(25, 14),
    periodic: false,
    horizonSec: 2.20,
    start: { x: -25, z: 0, yaw: 0, vx: 26.0, vy: 0, r: 0, delta: 0.35 * 0.48, fx: 0 },
    target: { v_x: 18.0 },
    guessGenerator: (k, N, T = 2.2) => {
      const u = k / N;
      const th = u * (Math.PI / 2);
      const v = 26 - 8 * u;
      return {
        state: { x: -25 * Math.cos(th), z: 25 * Math.sin(th) + 15 * u, yaw: th, vx: v, vy: -0.2 * u, r: 0.65 * u, delta: 0.35 * 0.48, fx: 500 },
        control: { steer: 0.35, throttle: 0.15, brake: 0 }
      };
    }
  },

  // Problem F: Chicane (R = 40 m)
  {
    id: 'case_f_chicane',
    name: 'F. Chicane',
    description: 'Rapid directional reversal testing steering rate limits and transient yaw momentum',
    track: createChicaneTrack(14),
    periodic: false,
    horizonSec: 2.80,
    start: { x: 0, z: -80, yaw: 0, vx: 36.0, vy: 0, r: 0, delta: 0, fx: 0 },
    target: { v_x: 34.0 },
    guessGenerator: (k, N, T = 2.8) => {
      const u = k / N;
      const steer = 0.18 * Math.sin(u * 2 * Math.PI);
      return {
        state: { x: 4 * Math.sin(u * 2 * Math.PI), z: -80 + u * 160, yaw: 0.10 * Math.cos(u * 2 * Math.PI), vx: 35.0, vy: 0, r: 0, delta: steer * 0.48, fx: 500 },
        control: { steer, throttle: 0.25, brake: 0 }
      };
    }
  },

  // Problem G: S-Bend
  {
    id: 'case_g_sbend',
    name: 'G. S-Bend',
    description: 'Continuous flowing reverse-curve testing dynamic body slip angle transitions',
    track: createChicaneTrack(14),
    periodic: false,
    horizonSec: 3.00,
    start: { x: 0, z: -100, yaw: 0, vx: 36.0, vy: 0, r: 0, delta: 0, fx: 0 },
    target: { v_x: 35.0 },
    guessGenerator: (k, N, T = 3.0) => {
      const u = k / N;
      const steer = 0.16 * Math.sin(u * 2 * Math.PI);
      return {
        state: { x: 4.5 * Math.sin(u * 2 * Math.PI), z: -100 + u * 180, yaw: 0.08 * Math.cos(u * 2 * Math.PI), vx: 35.5, vy: 0, r: 0, delta: steer * 0.48, fx: 600 },
        control: { steer, throttle: 0.22, brake: 0 }
      };
    }
  },

  // Problem H: Trail-Brake Problem
  {
    id: 'case_h_trail_brake',
    name: 'H. Trail-Brake Problem',
    description: 'Aggressive high-speed entry (45 m/s) with simultaneous turn-in and threshold decel into R=30m apex',
    track: createTrailBrakeTrack(30, 14),
    periodic: false,
    horizonSec: 1.85,
    start: { x: -30, z: -50, yaw: 0, vx: 45.0, vy: 0, r: 0, delta: 0, fx: 0 },
    target: { v_x: 20.0 },
    guessGenerator: (k, N, T = 1.85) => {
      const u = k / N;
      // Straight approach: -50 to -15, then trail-brake and turn in into (0, 30)
      const v = 45 - 25 * u;
      const steer = u < 0.25 ? 0 : 0.22 * Math.pow((u - 0.25) / 0.75, 1.2);
      const brk = 0.80 * Math.max(0, 1 - 0.3 * u);
      const x = u < 0.25 ? -30 : -30 + 30 * ((u - 0.25) / 0.75);
      const z = u < 0.25 ? -50 + (u / 0.25) * 35 : -15 + 45 * ((u - 0.25) / 0.75);
      return {
        state: { x, z, yaw: steer * 0.8, vx: v, vy: -0.3 * steer, r: steer * 0.6, delta: steer * 0.48, fx: -12000 * (1 - 0.3 * u) },
        control: { steer, throttle: 0, brake: brk }
      };
    }
  },

  // Problem I: Corner Exit
  {
    id: 'case_i_corner_exit',
    name: 'I. Corner Exit',
    description: 'Unwinding steering while applying full rear-wheel power without exceeding rear traction budget',
    track: createCornerExitTrack(50, 14),
    periodic: false,
    horizonSec: 2.40,
    start: { x: 0, z: 50, yaw: Math.PI / 2, vx: 22.0, vy: 0, r: 22.0 / 50, delta: 0.05, fx: 1200 },
    target: { v_x: 36.0 },
    guessGenerator: (k, N, T = 2.4) => {
      const u = k / N;
      const steer = 0.12 * (1 - u);
      const thr = 0.35 + 0.65 * u;
      return {
        state: { x: u * 80, z: 50 - 5 * u, yaw: Math.PI / 2 - 0.08 * u, vx: 22 + 14 * u, vy: 0, r: 0.15 * (1 - u), delta: steer * 0.48, fx: 1500 + 3500 * u },
        control: { steer, throttle: thr, brake: 0 }
      };
    }
  }
];
