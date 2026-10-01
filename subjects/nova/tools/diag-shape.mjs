import { Track } from "../src/sim/track.js";
import { buildTrackModel } from "../src/tracks/track-model.js";
const track = new Track("harbor-ring");
const model = buildTrackModel(track, { spacing: 1 });
console.log("  s     x       z     heading  kappa  radius");
for (let s = 780; s <= 1120; s += 10) {
  const i = model.index(s);
  const k = model.kappa[i];
  console.log(
    s.toString().padStart(5),
    model.x[i].toFixed(1).padStart(8),
    model.z[i].toFixed(1).padStart(8),
    model.heading[i].toFixed(3).padStart(8),
    k.toFixed(4).padStart(8),
    (Math.abs(k) > 1e-4 ? (1 / Math.abs(k)).toFixed(0) : "inf").padStart(6),
  );
}
