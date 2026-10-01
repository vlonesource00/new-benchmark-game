import { Track } from "../src/sim/track.js";
import { buildTrackModel } from "../src/tracks/track-model.js";
import { createEnvelope } from "../src/ai/global/envelope.js";
import { CAR_CLASSES } from "../src/sim/car-specs.js";
import { buildPath } from "../src/ai/global/path-geometry.js";
import { speedProfile } from "../src/ai/global/speed-profile.js";
const track = new Track("harbor-ring");
const env = createEnvelope(CAR_CLASSES.gt, {});
for (const span of [1.5, 2.5, 4.0]) {
  const row = [];
  for (const spacing of [4, 2, 1, 0.5]) {
    const model = buildTrackModel(track, { spacing });
    const path = buildPath(model, new Float64Array(model.n), { headingHalfSpan: span });
    const profile = speedProfile(path, env, { iterations: 12 });
    let maxK = 0; for (const k of path.kappa) maxK = Math.max(maxK, Math.abs(k));
    row.push(`${spacing}m:${profile.time.toFixed(2)}s/k${maxK.toFixed(3)}`);
  }
  console.log(`span ${span}m  ` + row.join("  "));
}
