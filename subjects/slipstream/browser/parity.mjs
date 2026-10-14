// JS actor vs torch on an exported fixture.  node subjects/slipstream/browser/parity.mjs <name>
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Policy } from './policy.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'runs', 'export'), name = process.argv[2];
const pol = new Policy(JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')));
const fx = JSON.parse(readFileSync(join(dir, `${name}.fixture.json`), 'utf8'));
let worst = 0; const t0 = performance.now();
fx.raw.forEach((raw, t) => {
  const mu = pol.act(Float32Array.from(raw), fx.first[t] > 0.5, fx.decide[t] > 0.5);
  worst = Math.max(worst, Math.abs(mu[0] - fx.mu[t][0]), Math.abs(mu[1] - fx.mu[t][1]));
});
const ms = (performance.now() - t0) / fx.raw.length;
console.log(JSON.stringify({ steps: fx.raw.length, maxAbsDiff: +worst.toExponential(2), msPerStep: +ms.toFixed(3) }));
console.log(worst < 1e-4 ? 'PASS' : 'FAIL');
process.exit(worst < 1e-4 ? 0 : 1);
