// Every track-limit excursion of the learner in a replay: where, how far over the limit, how long, at what speed.
//   node subjects/slipstream/viewer/offsites.mjs <run> <replay>
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const [run, name] = process.argv.slice(2);
const R = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'runs', run, 'replays', name + '.json'), 'utf8'));
const g = R.geometry, ci = R.frames[0].agents[0][0], lim = g.halfWidth + g.curbWidth;
let cur = null; const out = [];
for (let k = 1; k < R.frames.length; k++) {
  const c = R.frames[k].cars[ci], p = R.frames[k - 1].cars[ci], illegal = c[10] > p[10] + 1e-6;
  if (illegal) { cur ??= { t: R.frames[k].t, s: c[7], over: 0, dur: 0, v: c[3] * 3.6, side: Math.sign(c[8]) }; cur.over = Math.max(cur.over, Math.abs(c[8]) - lim); cur.dur += c[10] - p[10]; }
  else if (cur) { out.push(cur); cur = null; }
}
const byS = {};
for (const e of out) { const b = Math.round(e.s / 25) * 25; (byS[b] ??= []).push(e); }
console.log(`${name}: ${out.length} excursions in ${R.frames.at(-1).t.toFixed(0)} s; limit = half width ${g.halfWidth} + kerb ${g.curbWidth} (centre lateral; the game judges half the car)`);
for (const [s, es] of Object.entries(byS).sort((a, b) => b[1].length - a[1].length))
  console.log(`  s~${s.padStart(5)}  x${es.length}  side ${es[0].side > 0 ? '+' : '-'}  centre over ${Math.max(...es.map((e) => e.over)).toFixed(2)} m  dur ${(es.reduce((a, e) => a + e.dur, 0) / es.length).toFixed(2)} s  v ${Math.round(es[0].v)} km/h`);
