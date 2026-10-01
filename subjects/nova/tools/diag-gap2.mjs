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
console.log("   s    | k@1m   v@1m  cv@1m | k@.5m  v@.5m cv@.5m");
for (let s = 1240; s <= 1360; s += 4) {
  const a = out[1], b = out[0.5];
  const i1 = a.model.index(s), ih = b.model.index(s);
  console.log(
    `${s.toFixed(0).padStart(5)} | ${a.path.kappa[i1].toFixed(4).padStart(7)} ${a.profile.v[i1].toFixed(1).padStart(6)} ${a.profile.curveV[i1].toFixed(1).padStart(6)} | ` +
    `${b.path.kappa[ih].toFixed(4).padStart(7)} ${b.profile.v[ih].toFixed(1).padStart(6)} ${b.profile.curveV[ih].toFixed(1).padStart(6)}`,
  );
}
