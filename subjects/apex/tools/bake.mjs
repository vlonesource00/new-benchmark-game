// Bakes minimum-time lines into data/lines.json, keyed by track id and car class.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/bake.mjs [track ...] [--classes=lmdh,gt] [--iter=30000] [--edge=-0.5] [--ds=3]
import { readFileSync, writeFileSync } from 'node:fs';
import { Track } from '../../../game/engine/sim/track.js';
import { Line } from '../src/line.js';
import { CarModel } from '../src/model.js';

const args = process.argv.slice(2), flag = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const tracks = args.filter((a) => !a.startsWith('--')), classes = flag('classes', 'lmdh,gt').split(',');
const iterations = Number(flag('iter', 30000)), edge = Number(flag('edge', -0.5)), ds = Number(flag('ds', 3)), margin = Number(flag('margin', 0.9)), jerk = Number(flag('jerk', 40));
const file = new URL('../data/lines.json', import.meta.url);
let lines = {}; try { lines = JSON.parse(readFileSync(file, 'utf8')); } catch {}
for (const id of tracks.length ? tracks : ['harbor-ring', 'solenne', 'alpine', 'desert']) {
  const track = new Track(id);
  for (const cls of classes) {
    const t0 = Date.now(), model = new CarModel(cls), line = new Line(track, { ds, edge });
    model.margin = margin; model.jerk = jerk;
    line.seed(); const seedT = line.speeds(model);
    const T = line.optimise(model, { iterations, seed: 7 });
    try { lines = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    (lines[id] ??= {})[cls] = { ...line.toJSON(), qss: +T.toFixed(3), margin, jerk };
    writeFileSync(file, JSON.stringify(lines));
    console.log(`${id} ${cls} N${line.N} seed ${seedT.toFixed(2)} → ${T.toFixed(2)} s (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
}
