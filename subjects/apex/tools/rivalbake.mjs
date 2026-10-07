// Bakes data/rivals.json: every reference architecture's own line and speed, per track and class (see rivalprofile.mjs).
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/rivalbake.mjs [--ais next-racer,claude-revolution,solstice] [--tracks harbor-ring,solenne,alpine,desert] [--classes lmdh,gt] [--jobs 3]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const list = (k, d) => String(flag(k, d)).split(',').filter(Boolean);
const ais = list('ais', 'next-racer,claude-revolution,solstice'), tracks = list('tracks', 'harbor-ring,solenne,alpine,desert'), classes = list('classes', 'lmdh,gt'), jobs = Number(flag('jobs', 3));
const out = fileURLToPath(new URL('../data/rivals.json', import.meta.url)), tool = fileURLToPath(new URL('./rivalprofile.mjs', import.meta.url));
const data = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
const todo = []; for (const t of tracks) for (const c of classes) for (const a of ais) if (!data[t]?.[c]?.[a]) todo.push({ t, c, a });
let next = 0;
const run = ({ t, c, a }) => new Promise((resolve) => {
  const p = spawn('node', ['--import', './scripts/json-loader.mjs', tool, a, c, t, '4'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let b = ''; p.stdout.on('data', (d) => { b += d; }); p.on('close', () => { try { resolve(JSON.parse(b.trim().split('\n').filter((x) => x.startsWith('{')).at(-1))); } catch { resolve(null); } });
});
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < todo.length) {
    const job = todo[next++], r = await run(job);
    if (!r) { console.error('failed', JSON.stringify(job)); continue; }
    ((data[job.t] ??= {})[job.c] ??= {})[job.a] = { N: r.N, ds: +r.ds.toFixed(5), lat: r.lat, v: r.v };
    writeFileSync(out, JSON.stringify(data));
    console.error('done', job.t, job.c, job.a);
  }
}));
console.error('all done');
