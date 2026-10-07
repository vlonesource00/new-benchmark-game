// The game's duel battery: APEX against one opponent, both pole orders, rolling start, 12 laps, strategists live, seat workers
// (tools/worker.mjs --duel). One line per race: winner, margin at the flag, incident points, contacts, stops.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/duelcamp.mjs [--opponents next-racer] [--tracks a,b] [--classes lmdh,gt] [--laps 12] [--seeds 7] [--jobs 2] [--out file.json]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const opponents = flag('opponents', 'next-racer').split(','), tracks = flag('tracks', 'harbor-ring,solenne,alpine,desert').split(','), classes = flag('classes', 'lmdh,gt').split(',');
const laps = flag('laps', '12'), seeds = flag('seeds', '7').split(','), jobs = Number(flag('jobs', 2)), out = flag('out', null);
const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const queue = []; for (const opp of opponents) for (const track of tracks) for (const cls of classes) for (const seed of seeds) for (const apexFirst of [true, false]) queue.push({ opp, track, cls, seed, apexFirst });
const results = []; let running = 0, next = 0;
await new Promise((done) => {
  const pump = () => {
    while (running < jobs && next < queue.length) {
      const j = queue[next++]; running++;
      const drivers = j.apexFirst ? `apex,${j.opp}` : `${j.opp},apex`;
      const p = spawn('node', ['--import', './scripts/json-loader.mjs', worker, '--duel', `--drivers=${drivers}`, `--class=${j.cls}`, `--track=${j.track}`, `--laps=${laps}`, `--seed=${j.seed}`], { stdio: ['ignore', 'pipe', 'inherit'] });
      let buf = ''; p.stdout.on('data', (d) => { buf += d; });
      p.on('close', () => {
        let r = null; try { r = JSON.parse(buf.trim().split('\n').pop()); } catch {}
        if (r) {
          const a = j.apexFirst ? 0 : 1, o = 1 - a, fa = r.finish[a], fo = r.finish[o];
          const row = { ...j, apexFinish: fa, oppFinish: fo, margin: fa != null && fo != null ? +(fo - fa).toFixed(1) : null, win: fa != null && (fo == null || fa < fo), apexInc: r.incidents[a], oppInc: r.incidents[o], contacts: r.contacts, apexStops: r.stints[a].stops, oppStops: r.stints[o].stops, apexBest: Math.min(...r.laps[a].slice(1)), oppBest: Math.min(...r.laps[o].slice(1)), tyres: r.tyres[a].map((t) => t[0]).join('') };
          results.push(row);
          console.log(`${j.opp.slice(0, 4)} ${j.track.padEnd(12)} ${j.cls.padEnd(4)} s${j.seed} ${j.apexFirst ? 'APX pole' : 'APX 2nd '}  ${row.win ? 'WIN ' : 'LOSS'} margin ${row.margin} s | inc ${row.apexInc}/${row.oppInc} contacts ${row.contacts} | stops ${row.apexStops}/${row.oppStops} | best ${row.apexBest}/${row.oppBest}`);
        } else console.log(`FAILED ${JSON.stringify(j)}`);
        running--; if (next >= queue.length && running === 0) done(); else pump();
      });
    }
  };
  pump();
});
const w = results.filter((r) => r.win).length, m = results.filter((r) => r.margin != null);
console.log(`\nAPEX wins ${w} of ${results.length}; mean margin ${(m.reduce((a, r) => a + r.margin, 0) / Math.max(1, m.length)).toFixed(1)} s; APEX incident points ${results.reduce((a, r) => a + r.apexInc, 0)} (max ${Math.max(...results.map((r) => r.apexInc))}); contacts ${results.reduce((a, r) => a + r.contacts, 0)}`);
if (out) writeFileSync(out, JSON.stringify(results, null, 1));
