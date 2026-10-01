import { Track } from "../src/sim/track.js";
import { buildTrackModel } from "../src/tracks/track-model.js";
import { CAR_CLASSES } from "../src/sim/car-specs.js";
import { createEnvelope } from "../src/ai/global/envelope.js";
import { LINE } from "../src/tracks/lines/harbor-ring-gt.js";
import { makeBasis, expandBumps } from "../src/ai/global/line-optimizer.js";
import { buildPath } from "../src/ai/global/path-geometry.js";
import { speedProfile } from "../src/ai/global/speed-profile.js";
const track = new Track("harbor-ring");
const env = createEnvelope(CAR_CLASSES.gt, {});
const profiles = {}, paths = {}, models = {};
for (const spacing of [1, 0.5]) {
  const model = buildTrackModel(track, { spacing });
  const basis = makeBasis(model, { widths: LINE.widths });
  const q = expandBumps(model, basis, Float64Array.from(LINE.coeffs));
  const path = buildPath(model, q);
  const profile = speedProfile(path, env, { iterations: 16 });
  models[spacing] = model; paths[spacing] = path; profiles[spacing] = profile;
  console.log(`spacing ${spacing}: ${profile.time.toFixed(3)} s`);
}
console.log("\n   s     v@1m   v@0.5m   dv    k@1m   k@0.5m");
let worst = [];
for (let s = 0; s < 2704; s += 1) {
  const i1 = models[1].index(s), ih = models[0.5].index(s);
  const dv = profiles[0.5].v[ih] - profiles[1].v[i1];
  if (Math.abs(dv) > 1.0) worst.push({ s, v1: profiles[1].v[i1], vh: profiles[0.5].v[ih], k1: paths[1].kappa[i1], kh: paths[0.5].kappa[ih] });
}
worst.sort((a, b) => Math.abs(b.v1 - b.vh) - Math.abs(a.v1 - a.vh));
for (const w of worst.slice(0, 20)) {
  console.log(`${w.s.toFixed(0).padStart(5)} ${w.v1.toFixed(1).padStart(6)} ${w.vh.toFixed(1).padStart(7)} ${(w.vh-w.v1).toFixed(1).padStart(6)} ${w.k1.toFixed(4).padStart(7)} ${w.kh.toFixed(4).padStart(8)}`);
}
