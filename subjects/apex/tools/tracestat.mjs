// Summarise a duel --trace log for one APEX car (the n-th trace line of each tick): how long it sat behind a car, in
// which planner state, at what gap and closing speed.   node subjects/apex/tools/tracestat.mjs <file> [carIndex=1]
import { readFileSync } from 'node:fs';
const [file, idx = '1', stride = '2'] = process.argv.slice(2);
const rows = readFileSync(file, 'utf8').split('\n').map((l) => /^(\d+\.\d) L(\d+) s(\d+) v([\d.]+) lat(-?[\d.]+) (\w+)\/(\w+) A(-?[\d.]+) cap(-|\d+) lead (?:ds(-?\d+) v(\d+) lat(-?[\d.]+)|-)/.exec(l)).filter(Boolean);
const mine = rows.filter((_, k) => k % Number(stride) === Number(idx)), segs = [];
let cur = null;
for (const m of mine) {
  const t = +m[1], ds = m[10] != null ? +m[10] : null, near = ds != null && ds < 40;
  if (near) { if (!cur) segs.push(cur = { t0: t, n: 0, states: {}, dsMin: 1e9, closing: 0, s0: +m[3], lap: +m[2] }); cur.n++; cur.t1 = t; cur.states[m[6] + '/' + m[7]] = (cur.states[m[6] + '/' + m[7]] ?? 0) + 1; cur.dsMin = Math.min(cur.dsMin, ds); cur.closing += +m[4] - +m[11]; } else cur = null;
}
for (const g of segs.filter((x) => x.n >= 5)) console.log(`L${g.lap} s${g.s0} t${g.t0}-${g.t1} (${(g.t1 - g.t0).toFixed(1)} s) dsMin ${g.dsMin} meanClosing ${(g.closing / g.n).toFixed(2)} ${JSON.stringify(g.states)}`);
const all = {}; for (const m of mine) all[m[6] + '/' + m[7]] = (all[m[6] + '/' + m[7]] ?? 0) + 1;
console.log('overall states', JSON.stringify(all));
