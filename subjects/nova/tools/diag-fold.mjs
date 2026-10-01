import { Track } from "../src/sim/track.js";
import { buildTrackModel } from "../src/tracks/track-model.js";
import { CAR_CLASSES } from "../src/sim/car-specs.js";
import { createEnvelope } from "../src/ai/global/envelope.js";
import { LINE } from "../src/tracks/lines/harbor-ring-gt.js";
import { makeBasis, expandBumps } from "../src/ai/global/line-optimizer.js";
import { buildPath } from "../src/ai/global/path-geometry.js";
const track = new Track("harbor-ring");
for (const spacing of [2, 1, 0.5]) {
  const model = buildTrackModel(track, { spacing });
  const basis = makeBasis(model, { widths: LINE.widths });
  const q = expandBumps(model, basis, Float64Array.from(LINE.coeffs));
  const path = buildPath(model, q);
  let worst = 0, wi = 0;
  for (let i = 0; i < path.n; i++) if (Math.abs(path.kappa[i]) > worst) { worst = Math.abs(path.kappa[i]); wi = i; }
  let maxQ = 0; for (const v of q) maxQ = Math.max(maxQ, Math.abs(v));
  console.log(`spacing ${spacing}: pathLength ${path.length.toFixed(1)} maxQ ${maxQ.toFixed(2)} worstK ${worst.toFixed(4)} at s=${(wi*model.ds).toFixed(0)} (R=${(1/worst).toFixed(1)}m) centreR=${(1/Math.abs(model.kappa[wi])).toFixed(1)}`);
  for (let k = -3; k <= 3; k++) {
    const i = (wi + k + path.n) % path.n;
    console.log(`   s=${(i*model.ds).toFixed(1).padStart(7)} q=${q[i].toFixed(2).padStart(6)} k=${path.kappa[i].toFixed(4).padStart(8)}`);
  }
}
