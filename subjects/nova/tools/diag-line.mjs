import { Track } from "../src/sim/track.js";
import { buildTrackModel } from "../src/tracks/track-model.js";
import { createEnvelope } from "../src/ai/global/envelope.js";
import { CAR_CLASSES } from "../src/sim/car-specs.js";
import { buildPath, expandNodes } from "../src/ai/global/path-geometry.js";
import { speedProfile } from "../src/ai/global/speed-profile.js";
import { LINE } from "../src/tracks/lines/harbor-ring-gt.js";

const track = new Track("harbor-ring");
const model = buildTrackModel(track, { spacing: 1.0 });
const env = createEnvelope(CAR_CLASSES.gt, {});
const q = expandNodes(model, LINE.count, Float64Array.from(LINE.nodes));
const path = buildPath(model, q);
const profile = speedProfile(path, env, { iterations: 14 });
console.log("model lap", profile.time.toFixed(2), "s; length", path.length.toFixed(1));
console.log("   s      q     kappa    v    vCurve  latUse");
for (let s = 760; s <= 1000; s += 8) {
  const i = model.index(s);
  const k = path.kappa[i];
  const lat = profile.v[i] * profile.v[i] * Math.abs(k);
  console.log(
    s.toString().padStart(5),
    q[i].toFixed(2).padStart(6),
    k.toFixed(4).padStart(8),
    profile.v[i].toFixed(1).padStart(6),
    profile.curveV[i].toFixed(1).padStart(7),
    (lat / env.latMax(profile.v[i])).toFixed(2).padStart(6),
  );
}
let lost = 0;
for (let s = 780; s < 1000; s += model.ds) {
  const i = model.index(s), j = model.index(s + model.ds);
  lost += model.ds / (0.5*(profile.v[i]+profile.v[j]));
}
console.log("time in 780-1000:", lost.toFixed(2), "s   (distance 220 m, avg", (220/lost).toFixed(1), "m/s)");
