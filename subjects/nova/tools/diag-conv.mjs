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
for (const spacing of [1, 0.5]) {
  const model = buildTrackModel(track, { spacing });
  const basis = makeBasis(model, { widths: LINE.widths });
  const q = expandBumps(model, basis, Float64Array.from(LINE.coeffs));
  const path = buildPath(model, q);
  const row = [];
  for (const it of [8, 16, 32, 64, 128]) row.push(`${it}:${speedProfile(path, env, { iterations: it }).time.toFixed(3)}`);
  console.log(`spacing ${spacing}  ` + row.join("  "));
}
