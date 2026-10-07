// Solo pace by compound: the same flying-lap protocol as baseline.mjs (tools/solo.mjs, no stop inside the laps), but over
// several compounds and without touching data/baseline.json.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/compounds.mjs [--ais next-racer,apex] [--compounds soft,medium,hard]
//        [--tracks a,b] [--classes lmdh,gt] [--laps 4] [--jobs 4] [--opts '{"notch":false}']
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const ais = flag('ais', 'next-racer,apex').split(','), compounds = flag('compounds', 'soft,medium,hard').split(','), classes = flag('classes', 'lmdh,gt').split(',');
const tracks = flag('tracks', 'harbor-ring,solenne,alpine,desert').split(','), laps = flag('laps', '4'), jobs = Number(flag('jobs', 4)), opts = flag('opts', '{}');
const solo = fileURLToPath(new URL('./solo.mjs', import.meta.url));
const queue = []; for (const compound of compounds) for (const cls of classes) for (const track of tracks) for (const ai of ais) queue.push({ compound, cls, track, ai });
const results = new Map(); let running = 0, next = 0;
const key = (j) => `${j.compound}|${j.cls}|${j.track}|${j.ai}`;
await new Promise((done) => {
  const pump = () => {
    while (running < jobs && next < queue.length) {
      const j = queue[next++]; running++;
      const p = spawn('node', ['--import', './scripts/json-loader.mjs', solo, j.ai, j.cls, j.track, laps, j.compound, j.ai === 'apex' ? opts : '{}'], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = ''; p.stdout.on('data', (d) => { out += d; });
      p.on('close', () => {
        const line = out.trim().split('\n').pop(); try { results.set(key(j), JSON.parse(line)); } catch { results.set(key(j), null); }
        running--; if (next >= queue.length && running === 0) done(); else pump();
      });
    }
  };
  pump();
});
const f = (r) => (r ? `${r.best.toFixed(2)}` : '  -  ');
for (const compound of compounds) {
  console.log(`\n${compound}: best flying lap (laps 2..${laps}) ${ais.join(' / ')}   [delta of ${ais.at(-1)} vs ${ais[0]} in %]`);
  for (const cls of classes) for (const track of tracks) {
    const row = ais.map((ai) => results.get(key({ compound, cls, track, ai })));
    const d = row.length > 1 && row[0] && row.at(-1) ? ((row.at(-1).best / row[0].best - 1) * 100).toFixed(2) : '';
    const inc = row.map((r) => (r ? r.stat?.reduce?.((a, s) => a + (s.inc ?? 0), 0) : 0));
    console.log(`  ${cls.padEnd(5)} ${track.padEnd(12)} ${row.map(f).join(' / ')}   ${d.padStart(6)} %`, row.some((r) => r?.inc) ? ` inc ${row.map((r) => r?.inc ?? 0).join('/')}` : '');
  }
}
