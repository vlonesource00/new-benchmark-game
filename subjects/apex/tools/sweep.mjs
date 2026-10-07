// Sweeps one APEX option over values for a track/class and prints lap time, wear per lap and temperatures.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/sweep.mjs <lmdh|gt> <track> <option> v1,v2,... [laps=5] [base-json]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [cls, trackName, key, values, laps = '5', baseOpts = '{}'] = process.argv.slice(2);
const solo = fileURLToPath(new URL('./solo.mjs', import.meta.url)), vals = values.split(',');
const run = (v) => new Promise((resolve) => {
  const o = JSON.stringify({ ...JSON.parse(baseOpts), [key]: Number(v) });
  const p = spawn('node', ['--import', './scripts/json-loader.mjs', solo, 'apex', cls, trackName, laps, 'medium', o], { stdio: ['ignore', 'pipe', 'inherit'] });
  let b = ''; p.stdout.on('data', (d) => { b += d; }); p.on('close', () => { try { resolve({ v, r: JSON.parse(b.trim().split('\n').at(-1)) }); } catch { resolve({ v, r: null }); } });
});
const res = []; let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => { while (next < vals.length) res.push(await run(vals[next++])); }));
res.sort((a, b) => Number(a.v) - Number(b.v));
console.log(`${cls} ${trackName} ${key}   best   mean   wear/lap  coreF/R end  laps`);
for (const { v, r } of res) {
  if (!r) { console.log(v, 'FAILED'); continue; }
  const w = r.stat.map((s) => s.wear), wl = (w.at(-1) - w[0]) / Math.max(1, w.length - 1);
  console.log(`${String(v).padEnd(6)} ${String(r.best).padEnd(7)} ${String(r.mean).padEnd(7)} ${wl.toFixed(3)}    ${r.stat.at(-1).core}/${r.stat.at(-1).rear}   inc ${r.inc}  ${r.laps.join(' ')}`);
}
