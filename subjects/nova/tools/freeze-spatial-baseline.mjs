import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Track } from '../src/sim/track.js';
import { Session, makeNovaReferenceFromLine } from '../src/sim/session.js';
import { NOVA_FREE_AIR } from '../src/tracks/lines/harbor-ring-nova.js';

// Setup session with canonical Harbor Ring GT
const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt' });
const line = session.line;
const ref = makeNovaReferenceFromLine(line);

// Compute canonical SHA-256 for spatial arrays (q, x, z, heading, kappa)
function computeSpatialHash(q, x, z, heading, kappa) {
  const hash = createHash('sha256');
  for (const arr of [q, x, z, heading, kappa]) {
    const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    hash.update(buf);
  }
  return hash.digest('hex');
}

const spatialHash = computeSpatialHash(
  ref.q,
  ref.x,
  ref.z,
  ref.heading,
  ref.kappa
);

console.log('SPATIAL_REFERENCE_HASH:', spatialHash);

// Simulate the vehicle through Harbor Chicane (s: 2339.5 -> 2704.6)
// Using strict flying lap setup
session.novaFlying = {
  spawnMeters: 400,
  speedScale: 1.0,
  reference: ref,
  hud: false,
};
session.mode = 'practice';
session.laps = 2;
session.autopilot = true;
session.aiKind = 'nova';
session.aiOptions = { novaSpeedScale: 1.0, strict: true, trace: true };
session.start();

const car = session.cars[0];
session.drivers = session.cars.map((c) => session.makeDriver(c));
const driver = session.drivers[0];

const dt = 1 / 120;
let chicaneActive = false;
let chicaneDone = false;
const chicaneSamples = [];
let tChicaneStart = 0;
let tChicaneEnd = 0;

// Run until car finishes lap 1 or passes chicane
for (let step = 0; step < 120 * 150 && !chicaneDone; step++) {
  const s = car.s;
  const isFlyingLap = (car.race?.progress ?? 0) > 500;
  const inChicane = isFlyingLap && s >= 2339.5 && s <= 2704.6;

  if (inChicane && !chicaneActive) {
    chicaneActive = true;
    tChicaneStart = step * dt;
  }

  if (chicaneActive) {
    chicaneSamples.push({
      t: +(step * dt).toFixed(4),
      s: +s.toFixed(3),
      x: +car.x.toFixed(3),
      z: +car.z.toFixed(3),
      q: +(car.q ?? car.lateral ?? 0).toFixed(3),
      speed: +car.speed.toFixed(3),
      steer: +car.steering.toFixed(4),
      yaw: +car.yaw.toFixed(4),
      yawRate: +car.yawRate.toFixed(4),
      lateral: +car.lateral.toFixed(3),
    });

    if (s > 2704.0 || s < 2330.0) {
      chicaneActive = false;
      chicaneDone = true;
      tChicaneEnd = step * dt;
    }
  }

  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
}

console.log(`Chicane sampled: ${chicaneSamples.length} points, time: ${(tChicaneEnd - tChicaneStart).toFixed(3)}s`);

// Compute chicane baseline metrics
let chicanePathLength = 0;
let minSpeed = Infinity;
let maxSpeed = -Infinity;
let peakAbsQ = 0;
let minMargin = Infinity;
const roadHalfWidth = 8.2;
const carHalfWidth = 1.01;
let steeringReversals = 0;
let prevSteerSign = 0;

for (let i = 0; i < chicaneSamples.length; i++) {
  const pt = chicaneSamples[i];
  if (i > 0) {
    const prev = chicaneSamples[i - 1];
    chicanePathLength += Math.hypot(pt.x - prev.x, pt.z - prev.z);
    const steerSign = Math.sign(pt.steer);
    if (steerSign !== 0 && prevSteerSign !== 0 && steerSign !== prevSteerSign) {
      steeringReversals++;
    }
    if (steerSign !== 0) prevSteerSign = steerSign;
  }
  if (pt.speed < minSpeed) minSpeed = pt.speed;
  if (pt.speed > maxSpeed) maxSpeed = pt.speed;
  if (Math.abs(pt.q) > peakAbsQ) peakAbsQ = Math.abs(pt.q);
  const margin = roadHalfWidth - (Math.abs(pt.lateral) + carHalfWidth);
  if (margin < minMargin) minMargin = margin;
}

const entrySpeed = chicaneSamples[0]?.speed ?? 0;
const exitSpeed = chicaneSamples[chicaneSamples.length - 1]?.speed ?? 0;
const complexTime = +(tChicaneEnd - tChicaneStart).toFixed(3);

const chicaneBaseline = {
  entryStation: 2339.5,
  exitStation: 2704.6,
  pathLength: +chicanePathLength.toFixed(2),
  entrySpeedMs: entrySpeed,
  entrySpeedKmh: +(entrySpeed * 3.6).toFixed(1),
  minSpeedMs: minSpeed,
  minSpeedKmh: +(minSpeed * 3.6).toFixed(1),
  exitSpeedMs: exitSpeed,
  exitSpeedKmh: +(exitSpeed * 3.6).toFixed(1),
  complexTimeSec: complexTime,
  peakAbsQ: +peakAbsQ.toFixed(3),
  minBodyMarginMeters: +minMargin.toFixed(3),
  steeringReversals,
  sampleCount: chicaneSamples.length,
};

console.log('CHICANE_SPATIAL_BASELINE:', chicaneBaseline);

// Construct artifact data
const baselineArtifact = {
  version: '1.0.0',
  description: 'NOVA Live Spatial Baseline & Harbor Chicane Frozen Reference',
  commit: '5c31077',
  createdAt: new Date().toISOString(),
  track: {
    id: 'harbor-ring',
    name: 'Harbor Ring',
    length: track.length,
    halfWidth: 8.2,
  },
  reference: {
    kind: ref.kind,
    points: ref.n,
    spacing: ref.ds,
    length: ref.length,
    spatialReferenceHash: spatialHash,
    // Store downsampled representative spatial points (every 20 points ~ 10m) for fast diffing
    sampleCount: Math.ceil(ref.n / 20),
    samples: Array.from({ length: Math.ceil(ref.n / 20) }, (_, k) => {
      const idx = Math.min(ref.n - 1, k * 20);
      return {
        idx,
        s: +(idx * ref.ds).toFixed(2),
        q: +ref.q[idx].toFixed(4),
        x: +ref.x[idx].toFixed(3),
        z: +ref.z[idx].toFixed(3),
        heading: +ref.heading[idx].toFixed(4),
        kappa: +ref.kappa[idx].toFixed(6),
        v: +ref.v[idx].toFixed(2),
      };
    }),
  },
  chicaneSpatialBaseline: chicaneBaseline,
  chicaneDrivenTrajectory: chicaneSamples.filter((_, idx) => idx % 4 === 0), // sampled at ~30Hz
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/nova-live-spatial-baseline-v1.json', JSON.stringify(baselineArtifact, null, 2));
console.log('Saved baseline to artifacts/nova-live-spatial-baseline-v1.json');
