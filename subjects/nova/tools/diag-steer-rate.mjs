// Steering-rate feasibility: for a given line, compute the steering angle the
// driver must hold and how fast it must change. A line whose steering-rate
// demand exceeds the plant's actuator bandwidth is not drivable, regardless of
// how fast the quasi-steady model says it is.

import { Track } from '../src/sim/track.js';
import { buildTrackModel } from '../src/tracks/track-model.js';
import { CAR_CLASSES } from '../src/sim/car-specs.js';
import { createEnvelope } from '../src/ai/global/envelope.js';
import { LINE } from '../src/tracks/lines/harbor-ring-gt.js';
import { makeBasis, expandBumps } from '../src/ai/global/line-optimizer.js';
import { buildPath } from '../src/ai/global/path-geometry.js';
import { speedProfile } from '../src/ai/global/speed-profile.js';

const track = new Track('harbor-ring');
const model = buildTrackModel(track, { spacing: 0.5 });
const env = createEnvelope(CAR_CLASSES.gt, {});
const spec = CAR_CLASSES.gt;

function analyse(label, q) {
  const path = buildPath(model, q);
  const profile = speedProfile(path, env, { iterations: 14 });
  let maxSteerRate = 0, maxAt = 0, maxSteer = 0;
  let prevSteer = null;
  const rows = [];
  for (let i = 0; i < model.n; i++) {
    const kappa = path.kappa[i];
    const v = profile.v[i];
    const steer = Math.atan(spec.wheelbase * kappa) + 0.001 * v * v * kappa;
    const ds = path.ds[i];
    if (prevSteer !== null && ds > 0.05) {
      const rate = Math.abs(steer - prevSteer) / ds * v;   // rad/s at the wheel
      if (rate > maxSteerRate) { maxSteerRate = rate; maxAt = i * model.ds; }
      rows.push({ s: i * model.ds, rate, steer, kappa, v });
    }
    maxSteer = Math.max(maxSteer, Math.abs(steer));
    prevSteer = steer;
  }
  rows.sort((a, b) => b.rate - a.rate);
  console.log(`${label}: time ${profile.time.toFixed(2)} s  maxSteer ${(maxSteer * 57.3).toFixed(1)} deg  maxSteerRate ${maxSteerRate.toFixed(2)} rad/s at s=${maxAt.toFixed(0)}`);
  for (const r of rows.slice(0, 6)) {
    console.log(`    s=${r.s.toFixed(0).padStart(5)} rate=${r.rate.toFixed(2).padStart(6)} rad/s steer=${(r.steer * 57.3).toFixed(1).padStart(6)} deg k=${r.kappa.toFixed(4)} v=${r.v.toFixed(1)}`);
  }
}

analyse('centreline', new Float64Array(model.n));
const basis = makeBasis(model, { widths: LINE.widths, overlap: LINE.overlap });
analyse('baked', expandBumps(model, basis, Float64Array.from(LINE.coeffs)));
