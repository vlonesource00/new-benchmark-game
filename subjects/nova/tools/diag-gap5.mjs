import { Track } from "../src/sim/track.js";
import { buildTrackModel } from "../src/tracks/track-model.js";
import { CAR_CLASSES } from "../src/sim/car-specs.js";
import { createEnvelope } from "../src/ai/global/envelope.js";
import { LINE } from "../src/tracks/lines/harbor-ring-gt.js";
import { makeBasis, expandBumps } from "../src/ai/global/line-optimizer.js";
import { buildPath } from "../src/ai/global/path-geometry.js";
const track = new Track("harbor-ring");
const env = createEnvelope(CAR_CLASSES.gt, {});
const res = {};
for (const spacing of [1, 0.5, 0.25]) {
  const model = buildTrackModel(track, { spacing });
  const basis = makeBasis(model, { widths: LINE.widths });
  const q = expandBumps(model, basis, Float64Array.from(LINE.coeffs));
  const path = buildPath(model, q);
  res[spacing] = { model, path, q };
}
console.log("   s   |  k@1m    q@1m   |  k@0.5   q@0.5  |  k@0.25  q@0.25");
for (let s = 1320; s <= 1420; s += 5) {
  const row = [];
  for (const sp of [1, 0.5, 0.25]) {
    const i = res[sp].model.index(s);
    row.push(`${res[sp].path.kappa[i].toFixed(4).padStart(7)} ${res[sp].q[i].toFixed(2).padStart(6)}`);
  }
  console.log(s.toString().padStart(5), "|", row.join(" | "));
}
let w = { k: 0 };
for (let s = 1250; s < 1450; s += 0.25) {
  for (const sp of [1, 0.5]) {
    const i = res[sp].model.index(s);
    if (Math.abs(res[sp].path.kappa[i]) > Math.abs(w.k)) w = { k: res[sp].path.kappa[i], s, sp };
  }
}
console.log("worst |k| in 1250-1450:", w.k.toFixed(4), "at s=", w.s.toFixed(1), "spacing", w.sp);
