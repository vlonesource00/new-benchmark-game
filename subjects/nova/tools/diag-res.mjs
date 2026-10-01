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
for (const spacing of [4, 2, 1, 0.5]) {
  const model = buildTrackModel(track, { spacing });
  const basis = makeBasis(model, { widths: LINE.widths });
  const q = expandBumps(model, basis, Float64Array.from(LINE.coeffs));
  const path = buildPath(model, q);
  const profile = speedProfile(path, env, { iterations: 16 });
  let vmin = Infinity, smin = 0, worstOver = 0, worstS = 0, maxK = 0, maxKS = 0;
  for (let i = 0; i < model.n; i++) {
    const v = profile.v[i]; if (v < vmin) { vmin = v; smin = i * model.ds; }
    const lat = v * v * Math.abs(path.kappa[i]);
    const lim = env.latMax(v);
    if (lat / lim > worstOver) { worstOver = lat / lim; worstS = i * model.ds; }
    if (Math.abs(path.kappa[i]) > maxK) { maxK = Math.abs(path.kappa[i]); maxKS = i * model.ds; }
  }
  console.log(`spacing ${String(spacing).padStart(4)}: time ${profile.time.toFixed(2)}s  vmin ${vmin.toFixed(1)} at ${smin}  maxK ${maxK.toFixed(4)} at ${maxKS}  worst latUse ${worstOver.toFixed(2)} at ${worstS}`);
}
