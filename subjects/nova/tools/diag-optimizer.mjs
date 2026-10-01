import { Track } from '../src/sim/track.js';
import { buildTrackModel } from '../src/tracks/track-model.js';
import { createEnvelope } from '../src/ai/global/envelope.js';
import { CAR_CLASSES } from '../src/sim/car-specs.js';
import { buildPath } from '../src/ai/global/path-geometry.js';
import { speedProfile } from '../src/ai/global/speed-profile.js';
import { optimizeLine } from '../src/ai/global/line-optimizer.js';

const track = new Track('harbor-ring');
const env = createEnvelope(CAR_CLASSES.gt, {});
const model = buildTrackModel(track, { spacing: 1.0 });
const centre = speedProfile(buildPath(model, new Float64Array(model.n)), env, { iterations: 12 });
console.log(`centreline ${centre.time.toFixed(3)} s`);

const t0 = Date.now();
const result = optimizeLine(model, env, {
  nodeStep: 6,
  outerIterations: Number(process.argv[2] ?? 4),
  onProgress: (p) => console.log(`  [${p.seed ?? '-'}] outer ${p.outer ?? '-'}: ${p.time.toFixed(3)}`),
});
console.log(`optimised ${result.time.toFixed(3)} s in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
let maxK = 0;
for (const k of result.path.kappa) maxK = Math.max(maxK, Math.abs(k));
console.log(`path length ${result.path.length.toFixed(1)} m, max |kappa| ${maxK.toFixed(4)}`);
let mn = Infinity, mnS = 0;
for (let i = 0; i < result.profile.v.length; i++) {
  if (result.profile.v[i] < mn) { mn = result.profile.v[i]; mnS = i * model.ds; }
}
console.log(`minimum speed ${mn.toFixed(1)} m/s at s=${mnS.toFixed(0)}`);
console.log('speed by section:');
for (let base = 0; base < model.length; base += 200) {
  let lo = Infinity, hi = 0, t = 0;
  for (let d = 0; d < 200 && base + d < model.length; d += model.ds) {
    const i = model.index(base + d), j = model.index(base + d + model.ds);
    lo = Math.min(lo, result.profile.v[i]);
    hi = Math.max(hi, result.profile.v[i]);
    t += model.ds / Math.max(0.5, 0.5 * (result.profile.v[i] + result.profile.v[j]));
  }
  console.log(`  ${base.toFixed(0).padStart(4)}m: ${lo.toFixed(1).padStart(5)} - ${hi.toFixed(1).padStart(5)}  ${t.toFixed(2)}s`);
}
