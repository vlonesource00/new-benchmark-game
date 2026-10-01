import { Track } from "../src/sim/track.js";
import { buildTrackModel } from "../src/tracks/track-model.js";
import { LINE } from "../src/tracks/lines/harbor-ring-gt.js";
import { makeBasis, expandBumps } from "../src/ai/global/line-optimizer.js";
import { buildPath } from "../src/ai/global/path-geometry.js";
const track = new Track("harbor-ring");
const models = {};
for (const spacing of [2, 1, 0.5]) {
  const model = buildTrackModel(track, { spacing });
  const basis = makeBasis(model, { widths: LINE.widths });
  const q = expandBumps(model, basis, Float64Array.from(LINE.coeffs));
  const path = buildPath(model, q);
  models[spacing] = { model, q, path };
  console.log(`spacing ${spacing}: n=${model.n} pathLen=${path.length.toFixed(2)} maxQ=${Math.max(...Array.from(q, Math.abs)).toFixed(3)}`);
}
// compare at common physical positions
const s0 = 1600;
console.log("\n   s      q@2m    q@1m   q@0.5m   k@2m    k@1m   k@0.5m");
for (let d = 0; d < 40; d += 2) {
  const s = s0 + d;
  const i2 = models[2].model.index(s), i1 = models[1].model.index(s), ih = models[0.5].model.index(s);
  console.log(
    s.toFixed(1).padStart(6),
    models[2].q[i2].toFixed(3).padStart(8),
    models[1].q[i1].toFixed(3).padStart(8),
    models[0.5].q[ih].toFixed(3).padStart(8),
    models[2].path.kappa[i2].toFixed(4).padStart(8),
    models[1].path.kappa[i1].toFixed(4).padStart(8),
    models[0.5].path.kappa[ih].toFixed(4).padStart(8),
  );
}
