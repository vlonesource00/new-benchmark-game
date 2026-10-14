// Per-section pace comparison of two cars in one replay: time per lap in each section (from mean section speed),
// minimum speed, and where each car is on throttle.
//   node subjects/slipstream/viewer/compare.mjs <run> <replay> [carA=0] [carB=1] [skipSeconds=70] [section=50]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const [run, name, A = 0, B = 1, skip = 70, SEC = 50] = process.argv.slice(2).map((x, i) => (i < 2 ? x : Number(x)));
const R = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'runs', run, 'replays', name + '.json'), 'utf8'));
const L = R.geometry.length, nb = Math.ceil(L / SEC), F = R.frames;
const acc = [A, B].map(() => Array.from({ length: nb }, () => ({ v: 0, n: 0, min: Infinity, thr: 0, brk: 0, lat: 0 })));
for (let k = 1; k < F.length; k++) {
  if (F[k].t < skip) continue;
  [A, B].forEach((ci, j) => {
    const c = F[k].cars[ci], b = Math.floor((((c[7] % L) + L) % L) / SEC) % nb, a = acc[j][b];
    a.v += c[3]; a.n++; a.min = Math.min(a.min, c[3]); a.thr += c[5]; a.brk += c[6]; a.lat += c[8];
  });
}
const t = (a) => (a.n ? SEC / (a.v / a.n) : NaN), nA = R.cars[A].name, nB = R.cars[B].name;
const rows = acc[0].map((a, b) => ({ s: b * SEC, d: t(a) - t(acc[1][b]), a, b: acc[1][b] }));
console.log(`${name}: ${nA} vs ${nB}, sections of ${SEC} m after ${skip} s; section-speed lap ${rows.reduce((x, r) => x + t(r.a), 0).toFixed(2)} vs ${rows.reduce((x, r) => x + t(r.b), 0).toFixed(2)} s`);
console.log('     s        dt(s)   min km/h      thr        brk        lat(m)');
const f = (r) => `${String(r.s).padStart(6)}  ${(r.d >= 0 ? '+' : '') + r.d.toFixed(3)}  ${(3.6 * r.a.min).toFixed(0).padStart(4)} /${(3.6 * r.b.min).toFixed(0).padStart(4)}  ${(r.a.thr / r.a.n).toFixed(2)} / ${(r.b.thr / r.b.n).toFixed(2)}  ${(r.a.brk / r.a.n).toFixed(2)} / ${(r.b.brk / r.b.n).toFixed(2)}  ${(r.a.lat / r.a.n).toFixed(1).padStart(5)} /${(r.b.lat / r.b.n).toFixed(1).padStart(5)}`;
for (const r of [...rows].sort((x, y) => y.d - x.d).slice(0, 12)) console.log(f(r));
