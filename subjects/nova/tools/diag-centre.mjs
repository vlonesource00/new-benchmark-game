import { Track } from "../src/sim/track.js";
import { buildTrackModel } from "../src/tracks/track-model.js";
const track = new Track("harbor-ring");
const model = buildTrackModel(track, { spacing: 0.5 });
console.log("track.length", track.length.toFixed(4), "model.length", model.length.toFixed(4));
let worst = 0, worstS = 0, sum = 0;
for (let s = 0; s < track.length; s += 5) {
  const a = track.at(s);
  const i = model.index(s);
  const d = Math.hypot(a.x - model.x[i], a.z - model.z[i]);
  sum += d;
  if (d > worst) { worst = d; worstS = s; }
}
console.log("mean centerline mismatch", (sum / (track.length / 5)).toFixed(4), "m; worst", worst.toFixed(3), "at s=", worstS.toFixed(0));
// check a projected point round trip
for (const s of [500, 1000, 1500, 2000, 2500]) {
  const a = track.at(s);
  const proj = model.project(a.x, a.z);
  console.log(`s=${s}: project(at(s)) -> s'=${proj.s.toFixed(2)} q'=${proj.q.toFixed(3)}`);
}
