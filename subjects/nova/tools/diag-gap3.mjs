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
const out = {};
for (const spacing of [1, 0.5]) {
  const model = buildTrackModel(track, { spacing });
  const basis = makeBasis(model, { widths: LINE.widths });
  const q = expandBumps(model, basis, Float64Array.from(LINE.coeffs));
  const path = buildPath(model, q);
  const profile = speedProfile(path, env, { iterations: 16 });
  out[spacing] = { model, path, profile };
}
const a = out[1], b = out[0.5];
const cands = [];
for (let s = 0; s < 2704; s += 0.5) {
  const i1 = a.model.index(s), ih = b.model.index(s);
  const cv1 = a.profile.curveV[i1], cvh = b.profile.curveV[ih];
  cands.push({ s, cv1, cvh, k1: a.path.kappa[i1], kh: b.path.kappa[ih], d: Math.abs(cv1 - cvh) });
}
cands.sort((p, q) => q.d - p.d);
console.log("worst curveV gaps:");
for (const c of cands.slice(0, 16)) {
  console.log(`s=${c.s.toFixed(0).padStart(5)} cv1=${c.cv1.toFixed(1).padStart(6)} cv.5=${c.cvh.toFixed(1).padStart(6)} k1=${c.k1.toFixed(4).padStart(8)} k.5=${c.kh.toFixed(4).padStart(8)}`);
}
