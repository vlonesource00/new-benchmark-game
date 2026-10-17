// P1 validation of the field projector (STRATEGY-PLAN.md): scores the shadow predictions logged by
// `STRAT_SHADOW=1 strategy-race.mjs` against what happened in the same race.
//   node subjects/intercept/tools/shadow-check.mjs <label> [--verbose]
// Next-stop lap: for every prediction and every car, the first predicted stop at or after the prediction's lap
// against the first actual box call at or after it (both "none" counts as a hit). Finish: predicted place against
// the real classification, and the share of predictions within one place.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'results', 'strategy');
const label = process.argv[2], verbose = process.argv.includes('--verbose');
if (!label) { console.error('usage: shadow-check.mjs <label> [--verbose]'); process.exit(1); }

let stopN = 0, stopHit = 0, stopNear = 0, placeN = 0, placeHit = 0, placeNear = 0, errors = 0, ms = [];
const near = (n) => n <= 1;
for (const f of readdirSync(join(ROOT, label)).filter((x) => x.endsWith('.json'))) {
  const R = JSON.parse(readFileSync(join(ROOT, label, f), 'utf8'));
  if (!R.shadow) continue;
  const boxes = R.result.map((_, i) => R.decisions.filter((d) => d.car === i && d.box).map((d) => d.lap));
  const finalPlace = R.result.map((r) => r.place);
  const miss = [];
  for (const S of R.shadow) {
    if (S.error) { errors++; if (verbose) console.log(f, 'lap', S.lap, S.error); continue; }
    ms.push(S.ms);
    S.stops.forEach((pred, i) => {
      const p = pred.map((x) => x[0]).find((l) => l >= S.lap) ?? null, a = boxes[i].find((l) => l >= S.lap) ?? null;
      stopN++;
      if (p === a) stopHit++; else miss.push(`L${S.lap} car${i} ${R.result[i].ai}: pred ${p} real ${a}`);
      if (p === a || (p != null && a != null && near(Math.abs(p - a)))) stopNear++;
    });
    S.order.forEach((car, k) => { placeN++; const d = Math.abs(k + 1 - finalPlace[car]); if (d === 0) placeHit++; if (near(d)) placeNear++; });
  }
  const me = R.shadow[0]?.car;
  console.log(`${f}: ${R.shadow.length} predictions, intercept car ${me} finished P${finalPlace[me]}; pred P at each decision: ${R.shadow.map((S) => (S.order ? S.order.indexOf(S.car) + 1 : 'x')).join(' ')}`);
  if (verbose) miss.slice(0, 40).forEach((m) => console.log('  ', m));
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-');
ms.sort((a, b) => a - b);
console.log(`next stop lap exact ${pct(stopHit, stopN)} (+-1 ${pct(stopNear, stopN)}) of ${stopN}; finish place exact ${pct(placeHit, placeN)} (+-1 ${pct(placeNear, placeN)}); errors ${errors}; projection ms median ${ms[ms.length >> 1] ?? '-'} max ${ms.at(-1) ?? '-'}`);
