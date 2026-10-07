// Bake the stint priors: per track, class and compound, what a fresh set does lap by lap under APEX (tools/wearprobe.mjs at the 12-lap calibration).
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/wearbake.mjs [--tracks a,b] [--classes lmdh,gt] [--jobs 3] [--laps 12]
// Writes/merges data/stint.json: stint[track][class][compound] = { prior, tyreLaps, rows: [{ t, wear, dw, core }], warm: [...] }.
// --afterstop bakes `warm`: the stint on a set fitted warm in the pit (laps after the out-lap; the first row is the out-lap and has no usable time).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const tracks = flag('tracks', 'harbor-ring,solenne,alpine,desert,nurburgring').split(','), classes = flag('classes', 'lmdh,gt').split(','), jobs = Number(flag('jobs', 3)), laps = flag('laps', '12');
const probe = fileURLToPath(new URL('./wearprobe.mjs', import.meta.url)), file = new URL('../data/stint.json', import.meta.url);
let data = {}; try { data = JSON.parse(readFileSync(file, 'utf8')); } catch {}
const warm = args.includes('--afterstop');
const queue = []; for (const track of tracks) for (const cls of classes) for (const compound of ['soft', 'medium', 'hard']) queue.push({ track, cls, compound });
let running = 0, next = 0;
await new Promise((done) => {
  const pump = () => {
    while (running < jobs && next < queue.length) {
      const j = queue[next++]; running++;
      const stint = j.track === 'nurburgring' ? (warm ? 7 : 5) : (warm ? 11 : 9);
      const p = spawn('node', ['--import', './scripts/json-loader.mjs', probe, '--class', j.cls, '--track', j.track, '--laps', laps, '--compound', j.compound, '--stint', String(stint), ...(warm ? ['--afterstop'] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = ''; p.stdout.on('data', (d) => { out += d; });
      p.on('close', () => {
        try {
          const r = JSON.parse(out.trim().split('\n').pop());
          const entry = ((data[j.track] ??= {})[j.cls] ??= {})[j.compound] ??= {};
          const rows = r.rows.map(({ t, wear, dw, core }) => ({ t, wear, dw, core }));
          if (warm) entry.warm = rows; else Object.assign(entry, { prior: r.prior, tyreLaps: r.tyreLaps, rows });
          console.error(`done ${j.track} ${j.cls} ${j.compound}: ${r.rows.map((x) => x.t).join(' ')}`);
        } catch (err) { console.error(`FAILED ${j.track} ${j.cls} ${j.compound}`); }
        running--; if (next >= queue.length && running === 0) done(); else pump();
      });
    }
  };
  pump();
});
writeFileSync(file, JSON.stringify(data));
console.log('wrote data/stint.json');
