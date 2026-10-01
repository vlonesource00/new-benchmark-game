import { Track } from "../src/sim/track.js";
import { buildTrackModel } from "../src/tracks/track-model.js";
const track = new Track("harbor-ring");
const model = buildTrackModel(track, { spacing: 0.5 });
console.log("   s     model.x   model.z  | track.x  track.z  | d      model.tx  model.tz");
for (let s = 1490; s <= 1510; s += 2) {
  const a = track.at(s);
  const i = model.index(s);
  const d = Math.hypot(a.x - model.x[i], a.z - model.z[i]);
  console.log(`${s.toFixed(0).padStart(5)} ${model.x[i].toFixed(2).padStart(9)} ${model.z[i].toFixed(2).padStart(9)} | ${a.x.toFixed(2).padStart(8)} ${a.z.toFixed(2).padStart(8)} | ${d.toFixed(3).padStart(6)} ${model.tx[i].toFixed(2).padStart(8)} ${model.tz[i].toFixed(2).padStart(8)}`);
}
