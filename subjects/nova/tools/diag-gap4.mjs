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
console.log("   s  |  spacing 1          |  spacing 0.5");
console.log("      |  v    aLong  lim    |  v    aLong  lim");
for (const spacing of [1, 0.5]) {
  const model = buildTrackModel(track, { spacing });
  const basis = makeBasis(model, { widths: LINE.widths });
  const q = expandBumps(model, basis, Float64Array.from(LINE.coeffs));
  const path = buildPath(model, q);
  const profile = speedProfile(path, env, { iterations: 16 });
  globalThis[`out${spacing}`] = { model, profile };
}
for (let s = 1180; s <= 1360; s += 10) {
  const a = globalThis["out1"], b = globalThis["out0.5"];
  const i1 = a.model.index(s), ih = b.model.index(s);
  console.log(`${s.toString().padStart(5)} | ${a.profile.v[i1].toFixed(1).padStart(5)} ${a.profile.aLong[i1].toFixed(2).padStart(6)} ${a.profile.limit[i1]}     | ${b.profile.v[ih].toFixed(1).padStart(5)} ${b.profile.aLong[ih].toFixed(2).padStart(6)} ${b.profile.limit[ih]}`);
}
