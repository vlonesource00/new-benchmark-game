// Text trace of a replay around the learner's first failure.  node subjects/slipstream/viewer/trace.mjs <run> <replay> [secondsBefore]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const [run, name, before = 8] = process.argv.slice(2);
const R = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'runs', run, 'replays', name + '.json'), 'utf8'));
const g = R.geometry, ci = R.frames[0].agents[0][0], hw = g.halfWidth;
let k0 = R.frames.findIndex((f, k) => k > 0 && (f.cars[ci][10] > R.frames[k - 1].cars[ci][10] + 1e-6 || R.policy[k]?.[0][6]));
if (k0 < 0) { console.log('no failure in replay'); process.exit(0); }
const kEnd = R.policy.findIndex((p, k) => k >= k0 && p[0][6]);
console.log(`${name}: first off/end at t ${R.frames[k0].t.toFixed(2)} s, episode end at ${kEnd >= 0 ? R.frames[kEnd].t.toFixed(2) : '-'}; half width ${hw}, kerb ${g.curbWidth}`);
console.log('    t      s    v(km/h)  lat   edgeMargin  steerApp  sent(st,pd)   mu(st,pd)   thr  brk   off(s)  yaw-road');
const head = (s) => { const pts = g.centre, i = Math.floor((((s % g.length) + g.length) % g.length) / 2) % pts.length; return pts[i][2]; };
for (let k = Math.max(0, k0 - before * 30); k <= Math.min(R.frames.length - 1, (kEnd >= 0 ? kEnd : k0) + 15); k += 6) {
  const c = R.frames[k].cars[ci], a = R.frames[k].agents[0], p = R.policy[k][0];
  const dy = Math.atan2(Math.sin(c[2] - head(c[7])), Math.cos(c[2] - head(c[7])));
  console.log([R.frames[k].t.toFixed(2).padStart(6), c[7].toFixed(0).padStart(6), (c[3] * 3.6).toFixed(0).padStart(6), c[8].toFixed(2).padStart(6), (hw - Math.abs(c[8])).toFixed(2).padStart(7),
    c[4].toFixed(3).padStart(8), `${a[1].toFixed(2)},${a[2].toFixed(2)}`.padStart(12), `${p[0].toFixed(2)},${p[1].toFixed(2)}`.padStart(12), c[5].toFixed(2).padStart(5), c[6].toFixed(2).padStart(5), c[10].toFixed(2).padStart(7), dy.toFixed(3).padStart(8)].join(' '));
}
