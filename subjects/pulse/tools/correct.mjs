// Bounded DAgger collection. These are training mixtures, never racing benchmarks.
import { spawnSync } from 'node:child_process';
import { ROOT } from './versions.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name'), model = arg('model', 'artifacts/models/clone-50');
if (!name || !/^[a-z0-9-]+$/i.test(name)) throw Error('Give each correction round a unique --name');
const episodes = [
  { seed: 61, fixture: 'solo', start: 20, lateral: 0 },
  { seed: 62, fixture: 'train', start: 20, lateral: 0 },
  { seed: 63, fixture: 'pair', start: 650, lateral: -1 },
  { seed: 64, fixture: 'solo', start: 1550, lateral: 1 },
  { seed: 81, fixture: 'solo', start: 1000, lateral: -.5, split: 'validation' },
  { seed: 82, fixture: 'train', start: 150, lateral: .5, split: 'validation' }
];
for (const e of episodes) {
  const options = ['--mode', 'dagger', '--model', model, '--seconds', arg('seconds', '70'), '--expert-mix', arg('expert-mix', '.5'),
    '--expert-block-ms', arg('expert-block-ms', '100'), '--data-root', 'data/' + name, '--name', `${name}-${e.fixture}-${e.seed}`,
    '--split', e.split ?? 'train', '--fixture', e.fixture, '--seed', String(e.seed), '--start', String(e.start), '--lateral', String(e.lateral)];
  const r = spawnSync(process.execPath, ['--import', './scripts/json-loader.mjs', 'subjects/pulse/tools/record.mjs', ...options],
    { cwd: ROOT, encoding: 'utf8', timeout: 90000 });
  if (r.status !== 0) throw Error(r.stderr || r.error || `Recorder exited ${r.status}`);
  const s = JSON.parse(r.stdout.trim());
  console.log(JSON.stringify({ name: `${name}-${e.fixture}-${e.seed}`, split: e.split ?? 'train', rows: s.rows,
    expertFraction: s.expertRows / s.rows, progress: s.progress, damage: s.cumulativeDamage, offTrackSeconds: s.offTrackSeconds,
    scope: 'Training-only expert mixture; not independent policy performance.' }));
}
