// Compact view of a duel --trace --cands log for one APEX car: where the planner was, who was ahead and what each lane scored.
//   node subjects/apex/tools/candview.mjs <file> [from=0] [to=1e9] [maxDs=40] [every=1]
import { readFileSync } from 'node:fs';
const [file, from = '0', to = '1e9', maxDs = '40', every = '1', idx = '-1', stride = '2'] = process.argv.slice(2);
const rows = readFileSync(file, 'utf8').split('\n');
let k = 0, n = -1;
for (const l of rows) {
  const m = /^([\d.]+) L(\d) s(\d+) v([\d.]+) lat(-?[\d.]+) (\S+) A(\S+) cap(\S+) lead ds(-?\d+) v(\d+) lat(-?[\d.]+) cands (\[.*\]) best/.exec(l);
  if (!m) continue;
  n++; if (+idx >= 0 && n % +stride !== +idx) continue;
  const t = +m[1], ds = +m[9];
  if (t < +from || t > +to || ds > +maxDs || (k++ % +every)) continue;
  let c = []; try { c = JSON.parse(m[12]); } catch { /* empty when no plan */ }
  console.log(m[1], 's' + m[3], 'v' + m[4], 'lat' + m[5], m[6], 'ds' + ds, 'lv' + m[10], 'llat' + m[11], c.map((x) => (x.kind ?? x.tag) + (x.chosen ? '*' : '') + ':' + Math.round(x.score) + (x.risk > 1 ? '(' + Math.round(x.risk) + ')' : '')).join(' '));
}
