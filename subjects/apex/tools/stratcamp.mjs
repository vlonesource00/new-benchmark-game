// Race time of the host's default strategist against APEX's own, solo, over the formats: sprint 6, classic 12, marathon 20.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/stratcamp.mjs [--tracks a,b] [--classes lmdh,gt] [--formats sprint:6,classic:12,marathon:20] [--seeds 7,11] [--jobs 4]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const tracks = flag('tracks', 'harbor-ring,solenne,alpine,desert').split(','), classes = flag('classes', 'lmdh,gt').split(','), seeds = flag('seeds', '7').split(',');
const formats = flag('formats', 'sprint:6,classic:12,marathon:20').split(',').map((s) => s.split(':')), jobs = Number(flag('jobs', 4)), opts = flag('opts', '{}');
const lab = fileURLToPath(new URL('./stratlab.mjs', import.meta.url));
const queue = []; for (const [fmt, laps] of formats) for (const track of tracks) for (const cls of classes) for (const seed of seeds) for (const base of [true, false]) queue.push({ fmt, laps, track, cls, seed, base });
const results = new Map(); let running = 0, next = 0;
await new Promise((done) => {
  const pump = () => {
    while (running < jobs && next < queue.length) {
      const j = queue[next++]; running++;
      const p = spawn('node', ['--import', './scripts/json-loader.mjs', lab, '--default', ...(j.base ? ['--baseline'] : []), '--class', j.cls, '--track', j.track, '--laps', j.laps, '--format', j.fmt, '--seed', j.seed, '--opts', opts], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = ''; p.stdout.on('data', (d) => { out += d; });
      p.on('close', () => { try { results.set(`${j.fmt}|${j.track}|${j.cls}|${j.seed}|${j.base}`, JSON.parse(out.trim().split('\n').pop())); } catch { results.set(`${j.fmt}|${j.track}|${j.cls}|${j.seed}|${j.base}`, null); } running--; if (next >= queue.length && running === 0) done(); else pump(); });
    }
  };
  pump();
});
let sum = 0, n = 0, wins = 0;
for (const [fmt, laps] of formats) {
  console.log(`\n${fmt} (${laps} laps): default strategist / APEX strategist, s`);
  for (const track of tracks) for (const cls of classes) for (const seed of seeds) {
    const b = results.get(`${fmt}|${track}|${cls}|${seed}|true`), a = results.get(`${fmt}|${track}|${cls}|${seed}|false`);
    if (!a || !b) { console.log(`  ${track} ${cls} ${seed}: missing`); continue; }
    const d = a.time - b.time; sum += d; n++; if (d < 0) wins++;
    console.log(`  ${track.padEnd(12)} ${cls.padEnd(5)} s${seed} ${b.time.toFixed(1)} (${b.stops} stops, inc ${b.inc}) / ${a.time.toFixed(1)} (${a.stops} stops, inc ${a.inc})  ${d >= 0 ? '+' : ''}${d.toFixed(1)}  ${a.tyres.map((t) => t[0]).filter((x, i, arr) => i === 0 || x !== arr[i - 1]).join('')}`);
  }
}
console.log(`\nmean ${(sum / n).toFixed(1)} s per race, faster in ${wins} of ${n}`);
