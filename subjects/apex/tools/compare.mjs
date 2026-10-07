// Overlay two trace.mjs files by station and print where the second one loses (or gains) time.
//   node subjects/apex/tools/compare.mjs ref.json mine.json [step=3]
import { readFileSync } from 'node:fs';
const [a, b, st = '3'] = process.argv.slice(2), A = JSON.parse(readFileSync(a)), B = JSON.parse(readFileSync(b)), step = Number(st);
console.log(`${A.ai} ${A.lap.toFixed(2)}  vs  ${B.ai} ${B.lap.toFixed(2)}   (delta = mine - ref, + is slower)`);
console.log('  s    vRef  vMine  latRef latMine  ayRef ayMine thrR thrM brkR brkM  cumΔt');
let cum = 0;
for (let i = 0; i < A.rows.length; i += step) {
  let dt = 0, vr = 0, vm = 0, lr = 0, lm = 0, ar = 0, am = 0, tr = 0, tm = 0, br = 0, bm = 0, n = 0;
  for (let j = i; j < Math.min(A.rows.length, i + step); j++) {
    const x = A.rows[j], y = B.rows[j]; if (!x || !y) continue;
    dt += A.bin / y.v - A.bin / x.v; vr += x.v; vm += y.v; lr += x.lat; lm += y.lat; ar += Math.abs(x.ay); am += Math.abs(y.ay); tr += x.thr; tm += y.thr; br += x.brk; bm += y.brk; n++;
  }
  cum += dt; if (!n) continue;
  console.log(`${String(i * A.bin).padStart(5)} ${(vr / n).toFixed(1).padStart(6)} ${(vm / n).toFixed(1).padStart(6)} ${(lr / n).toFixed(1).padStart(6)} ${(lm / n).toFixed(1).padStart(6)} ${(ar / n).toFixed(0).padStart(6)} ${(am / n).toFixed(0).padStart(5)} ${(tr / n).toFixed(1)} ${(tm / n).toFixed(1)} ${(br / n).toFixed(1)} ${(bm / n).toFixed(1)} ${cum.toFixed(2).padStart(6)} ${Math.abs(dt) > 0.12 ? (dt > 0 ? ' <<< slower' : ' >>> faster') : ''}`);
}
