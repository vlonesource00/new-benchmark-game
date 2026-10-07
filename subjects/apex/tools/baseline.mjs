// Flying-lap baselines for the reference AIs (and APEX), measured with no stop in the laps.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/baseline.mjs [--ais next-racer,solstice,claude-revolution] [--tracks a,b] [--classes lmdh,gt] [--jobs 4]
// Writes data/baseline.json (merged) and prints the table.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), flag = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const ais = flag('ais', 'next-racer,solstice,claude-revolution').split(','), classes = flag('classes', 'lmdh,gt').split(',');
const tracks = flag('tracks', 'harbor-ring,solenne,alpine,desert,nurburgring').split(','), jobs = Number(flag('jobs', 4)), compound = flag('compound', 'medium');
const solo = fileURLToPath(new URL('./solo.mjs', import.meta.url)), file = new URL('../data/baseline.json', import.meta.url);
let data = {}; try { data = JSON.parse(readFileSync(file, 'utf8')); } catch {}
const queue = [];
for (const track of tracks) for (const cls of classes) for (const ai of ais) queue.push({ ai, cls, track, laps: track === 'nurburgring' ? 3 : 6 });
const run = (j) => new Promise((resolve) => {
  const p = spawn('node', ['--import', './scripts/json-loader.mjs', solo, j.ai, j.cls, j.track, String(j.laps), compound], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = ''; p.stdout.on('data', (d) => { buf += d; });
  p.on('close', () => { try { const r = JSON.parse(buf.trim().split('\n').at(-1)); ((data[j.track] ??= {})[j.cls] ??= {})[j.ai] = r; console.log(j.track, j.cls, j.ai, 'best', r.best, 'mean', r.mean, 'inc', r.inc, `${r.wall}s`); } catch { console.log('FAILED', j); } resolve(); });
});
let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => { while (next < queue.length) await run(queue[next++]); }));
writeFileSync(file, JSON.stringify(data));
