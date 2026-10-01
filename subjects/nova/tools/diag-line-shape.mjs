import { Track } from '../src/sim/track.js';
import { buildTrackModel } from '../src/tracks/track-model.js';
import { CAR_CLASSES } from '../src/sim/car-specs.js';
import { createEnvelope } from '../src/ai/global/envelope.js';
import { LINE } from '../src/tracks/lines/harbor-ring-gt.js';
import { makeBasis, expandBumps } from '../src/ai/global/line-optimizer.js';
import { buildPath } from '../src/ai/global/path-geometry.js';
import { speedProfile } from '../src/ai/global/speed-profile.js';

const args = process.argv.slice(2);
const from = Number(args[0] ?? 900);
const to = Number(args[1] ?? 1300);
const step = Number(args[2] ?? 5);

const track = new Track('harbor-ring');
const model = buildTrackModel(track, { spacing: 0.5 });
const env = createEnvelope(CAR_CLASSES.gt, {});
const basis = makeBasis(model, { widths: LINE.widths, overlap: LINE.overlap });
const q = expandBumps(model, basis, Float64Array.from(LINE.coeffs));
const path = buildPath(model, q);
const profile = speedProfile(path, env, { iterations: 14 });
console.log('    s      q     dq/ds   kappa    v    latUse  latMax');
for (let s = from; s <= to; s += step) {
  const i = model.index(s);
  const next = model.index(s + 1);
  const dq = (q[next] - q[i]) / Math.max(0.01, model.ds);
  const k = path.kappa[i];
  const v = profile.v[i];
  const lat = v * v * Math.abs(k);
  console.log(
    `${s.toFixed(0).padStart(5)} ${q[i].toFixed(2).padStart(7)} ${dq.toFixed(3).padStart(7)} ${k.toFixed(4).padStart(8)} ${v.toFixed(1).padStart(6)} ` +
    `${(lat / env.latMax(v)).toFixed(2).padStart(6)} ${env.latMax(v).toFixed(1).padStart(7)}`,
  );
}
let maxDq = 0, maxDqS = 0;
for (let i = 0; i < model.n; i++) {
  const j = (i + 1) % model.n;
  const d = Math.abs(q[j] - q[i]) / model.ds;
  if (d > maxDq) { maxDq = d; maxDqS = i * model.ds; }
}
console.log(`max |dq/ds| = ${maxDq.toFixed(3)} at s=${maxDqS.toFixed(0)}`);
