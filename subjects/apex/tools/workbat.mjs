// Seat-worker robustness battery: APEX alone through the game's AsyncSeats path, 12-lap endurance with stops, per track and class.
// Reports incident points, off-track/wall events and the race time. Options reach the worker through data/../config.json
// (edit it for an experiment and restore it), because the worker builds its driver from the shipped config.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/workbat.mjs [--tracks a,b] [--classes lmdh,gt] [--seeds 7,11] [--laps 12] [--jobs 4]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const tracks = flag('tracks', 'harbor-ring,solenne,alpine,desert').split(','), classes = flag('classes', 'lmdh,gt').split(','), seeds = flag('seeds', '7').split(','), laps = flag('laps', '12'), jobs = Number(flag('jobs', 4));
const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const queue = []; for (const track of tracks) for (const cls of classes) for (const seed of seeds) queue.push({ track, cls, seed });
const rows = []; let running = 0, next = 0;
await new Promise((done) => {
  const pump = () => {
    while (running < jobs && next < queue.length) {
      const j = queue[next++]; running++;
      const p = spawn('node', ['--import', './scripts/json-loader.mjs', worker, '--endurance', '--drivers=apex', `--class=${j.cls}`, `--track=${j.track}`, `--laps=${laps}`, `--seed=${j.seed}`], { stdio: ['ignore', 'pipe', 'inherit'] });
      let buf = ''; p.stdout.on('data', (d) => { buf += d; });
      p.on('close', () => {
        try { const r = JSON.parse(buf.trim().split('\n').pop()); rows.push({ ...j, inc: r.incidents[0], log: r.stewards[0], time: r.finish[0], stops: r.stints[0].stops }); } catch { rows.push({ ...j, inc: -1, log: ['FAILED'] }); }
        running--; if (next >= queue.length && running === 0) done(); else pump();
      });
    }
  };
  pump();
});
rows.sort((a, b) => (a.track + a.cls + a.seed).localeCompare(b.track + b.cls + b.seed));
for (const r of rows) console.log(`${r.track.padEnd(12)} ${r.cls.padEnd(4)} s${r.seed} inc ${String(r.inc).padStart(2)} time ${r.time} stops ${r.stops}  ${r.log.map((l) => l.replace(/ L\d+/, '')).join(', ').slice(0, 150)}`);
console.log(`total incident points ${rows.reduce((a, r) => a + Math.max(0, r.inc), 0)} over ${rows.length} runs, dirty runs ${rows.filter((r) => r.inc > 0).length}`);
