// Bakes REVOLUTION racing lines (min-curvature seed → min-time refinement)
// into data/lines.json, keyed by track id and car class.
//   node --import ./scripts/json-loader.mjs subjects/claude-revolution/tools/bake.mjs [track ...] [--classes=lmdh,gt] [--iter=60000]
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Track } from '../../../game/engine/sim/track.js';
import { Line } from '../src/line.js';
import { CarModel } from '../src/model.js';

const args = process.argv.slice(2), flag = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const tracks = args.filter((a) => !a.startsWith('--'));
const classes = flag('classes', 'lmdh,gt').split(','), iterations = Number(flag('iter', 60000));
const brakeExp = { lmdh: 1, gt: 2 };
const file = flag('out', null) ? pathToFileURL(flag('out')) : new URL('../data/lines.json', import.meta.url);
let lines = {}; try { lines = JSON.parse(readFileSync(file, 'utf8')); } catch {}
for (const id of tracks.length ? tracks : ['harbor-ring', 'solenne', 'alpine', 'desert']) {
  const track = new Track(id);
  for (const cls of classes) {
    const t0 = Date.now(), model = new CarModel(cls), line = new Line(track);
    line.brakeExp = brakeExp[cls] ?? 1;
    model.grip = 1 / 1.07;   // warm mediums: the compound most of a race runs on
    line.minCurvature(1500);
    const seedTime = line.speeds(model, 1), time = line.minTime(model, 1, iterations);
    (lines[id] ??= {})[cls] = { ...line.toJSON(), brakeExp: line.brakeExp, qss: Math.round(time * 100) / 100 };
    console.log(`${id} ${cls} N${line.N} min-curvature ${seedTime.toFixed(2)} → min-time ${time.toFixed(2)} s (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    writeFileSync(file, JSON.stringify(lines));
  }
}
