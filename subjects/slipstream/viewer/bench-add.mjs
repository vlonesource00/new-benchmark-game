// Records benchmark summary lines into runs/benchmarks.jsonl for the viewer's Benchmarks tab.
//   node subjects/slipstream/viewer/bench-add.mjs <log>...   (or summary lines on stdin)
// A summary line is "<bench> <model> key value key value ..." (the racecraft duel summaries), e.g.
//   duel3 moe2-10 meanPos 2.71 wins 1 gained 31 passes 46 lost 7 ... sep<3 13/46 unfinished 0
// Lines already recorded (same bench, model and values) are skipped, so a log can be re-added as it grows.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runs', 'benchmarks.jsonl');
const BENCH = /^(duel\d+)\s+(\S+)\s+(.*)$/;
// Model labels used by the benchmark scripts -> the checkpoint they ran (snapshot minutes after '-').
const source = (m) => {
  if (m === 'spec') return { run: 'tt-sn4', snap: 20, note: 'deployed Nürburgring specialist' };
  if (m.startsWith('hyb')) return { run: null, snap: null, note: 'specialist + combat net switched on traffic (scripted)' };
  const x = /^([a-z]+\d+)(?:-(\d+))?$/.exec(m);
  return x ? { run: 'tt-' + x[1], snap: x[2] ? +x[2] : null, note: '' } : { run: null, snap: null, note: '' };
};
const seen = new Set(existsSync(OUT) ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return r.key; }) : []);
const text = process.argv.length > 2 ? process.argv.slice(2).map((f) => readFileSync(f, 'utf8')).join('\n') : readFileSync(0, 'utf8');
let added = 0;
for (const line of text.split(/\r?\n/)) {
  const m = BENCH.exec(line.trim()); if (!m) continue;
  const [, bench, model, rest] = m, key = `${bench} ${model} ${rest}`;
  if (seen.has(key)) continue;
  const tok = rest.split(/\s+/), metrics = {};
  for (let i = 0; i + 1 < tok.length; i += 2) {
    const [k, v] = [tok[i], tok[i + 1]];
    if (/^\d+\/\d+$/.test(v)) { const [a, b] = v.split('/').map(Number); metrics[k] = [a, b]; } else metrics[k] = Number.isFinite(+v) ? +v : v;
  }
  appendFileSync(OUT, JSON.stringify({ key, bench, model, ...source(model), t: Date.now(), metrics }) + '\n');
  seen.add(key); added++;
}
console.log(`benchmarks: ${added} added`);
