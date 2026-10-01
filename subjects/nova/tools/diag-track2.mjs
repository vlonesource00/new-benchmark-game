import { Track } from "../src/sim/track.js";
import { buildTrackModel } from "../src/tracks/track-model.js";
const track = new Track("harbor-ring");
const model = buildTrackModel(track, { spacing: 2 });
let best = { d: Infinity };
for (let i = 0; i < model.n; i++) {
  for (let j = i + 1; j < model.n; j++) {
    const ds = Math.min(Math.abs(i - j), model.n - Math.abs(i - j)) * model.ds;
    if (ds < 120) continue;
    const d = Math.hypot(model.x[i] - model.x[j], model.z[i] - model.z[j]);
    if (d < best.d) best = { d, s1: i * model.ds, s2: j * model.ds };
  }
}
console.log("closest non-local centerline points:", best.d.toFixed(2), "m between s=", best.s1.toFixed(0), "and s=", best.s2.toFixed(0));
// print centerline around 1050-1250
console.log("   s      x       z      kappa   heading");
for (let s = 1040; s <= 1260; s += 10) {
  const i = model.index(s);
  console.log(`${s.toString().padStart(5)} ${model.x[i].toFixed(1).padStart(8)} ${model.z[i].toFixed(1).padStart(8)} ${model.kappa[i].toFixed(4).padStart(8)} ${model.heading[i].toFixed(3).padStart(8)}`);
}
