// Compare the analytic envelope against the human reference lap on this exact
// plant. Reports, per 100 m: human speed, envelope-predicted curve speed, the
// human's measured lateral and longitudinal accelerations versus the envelope,
// and where the model is more conservative than reality.

import { Track } from '../src/sim/track.js';
import { buildTrackModel } from '../src/tracks/track-model.js';
import { createEnvelope } from '../src/ai/global/envelope.js';
import { CAR_CLASSES } from '../src/sim/car-specs.js';
import { buildPath, nodesFromQ, expandNodes } from '../src/ai/global/path-geometry.js';
import { speedProfile } from '../src/ai/global/speed-profile.js';
import { humanReference } from '../src/render/human-reference.js';

const track = new Track('harbor-ring');
const model = buildTrackModel(track, { spacing: 0.5 });
const env = createEnvelope(CAR_CLASSES.gt, {});

const rows = humanReference.rows;
// Resample the human lateral trace onto every station by linear interpolation
// in distance, then to the 4 m node profile used by the optimiser.
const stationQ = new Float64Array(model.n);
{
  let cursor = 0;
  for (let i = 0; i < model.n; i++) {
    const s = i * model.ds;
    while (cursor < rows.length - 2 && rows[cursor + 1][0] < s) cursor++;
    const a = rows[cursor], b = rows[Math.min(cursor + 1, rows.length - 1)];
    const span = Math.max(1e-6, b[0] - a[0]);
    const f = Math.max(0, Math.min(1, (s - a[0]) / span));
    stationQ[i] = a[3] + (b[3] - a[3]) * f;
  }
}
const count = Math.round(model.length / 4);
const nodes = nodesFromQ(model, count, stationQ);
const q = expandNodes(model, count, nodes);
const path = buildPath(model, q);
const profile = speedProfile(path, env, { iterations: 14 });
console.log(`human lap:  ${humanReference.lapSeconds.toFixed(3)} s`);
console.log(`model on human line: ${profile.time.toFixed(3)} s`);

let maxRatio = 0, maxRatioS = 0, maxBrakeRatio = 0, maxBrakeS = 0;
console.log('\n  s      human   model   ratio   latH   latEnv  ratio | brakeH brakeEnv');
let index = 0;
let accum = { speed: 0, n: 0 };
const flush = (base) => {
  if (index % 200 !== 0) return;
  void base;
};
for (let i = 0; i < rows.length; i++) {
  const [s, t, v, qh] = rows[i];
  if (v === undefined) continue;
  const j = model.index(s);
  const ih = path.kappa[j];
  const latH = v * v * Math.abs(ih);
  const latEnvelope = env.latMax(v);
  const ratio = latH / latEnvelope;
  if (ratio > maxRatio) { maxRatio = ratio; maxRatioS = s; }
  let brakeH = 0, brakeEnv = 0;
  if (i > 0 && i < rows.length - 1) {
    const dv = rows[i + 1][2] - rows[i - 1][2];
    const dt = rows[i + 1][1] - rows[i - 1][1];
    const a = dv / Math.max(1e-6, dt);   // + accel, - decel
    const longH = -a;
    brakeH = Math.max(0, longH);
    brakeEnv = env.brakeMax(v, latH);
    const br = brakeH / Math.max(0.5, brakeEnv);
    if (br > maxBrakeRatio) { maxBrakeRatio = br; maxBrakeS = s; }
  }
  accum.speed += v; accum.n++;
  const base = Math.floor(s / 100) * 100;
  if (index % 400 === 0) flush(base);
  if (index % 40 === 0) {
    console.log(
      `${s.toFixed(0).padStart(5)} ${v.toFixed(1).padStart(7)} ${profile.v[j].toFixed(1).padStart(7)} ` +
      `${(v / Math.max(0.1, profile.v[j])).toFixed(3).padStart(7)} ${latH.toFixed(1).padStart(6)} ${latEnvelope.toFixed(1).padStart(7)} ` +
      `${ratio.toFixed(3).padStart(6)} | ${brakeH.toFixed(1).padStart(6)} ${brakeEnv.toFixed(1).padStart(8)}`,
    );
  }
  void qh; index++;
}
console.log(`\nmean human speed ${(accum.speed / accum.n).toFixed(2)} m/s`);
console.log(`max human lateral / envelope ratio ${maxRatio.toFixed(3)} at s=${maxRatioS}`);
console.log(`max human braking / envelope ratio ${maxBrakeRatio.toFixed(3)} at s=${maxBrakeS}`);
