// Broad, clean expert recoveries teach physical feedback, rather than copying
// near-zero steering for most of a lap. These are demonstrations, not student wins.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Track } from '../../../game/engine/sim/track.js';
import { ROOT, HOME } from './versions.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name'), seconds = +arg('seconds', 8);
const warm = args.includes('--warm');
if (!name || !/^[a-z0-9-]+$/i.test(name) || !(seconds >= 2 && seconds <= 20)) throw Error('Use a new simple name and bounded duration');
if (existsSync(resolve(HOME, 'data', name))) throw Error('Dataset exists; preserve it and use a new name');
const track = new Track('harbor-ring');
const quality = { name, accepted: [], rejected: [] };
const starts = warm ? [300, 650, 850, 1050, 1250, 1500, 1700, 1750, 1850, 2100, 2250, 2450] : [40, 350, 760, 1050, 1250, 1550, 1750, 2000, 2200, 2450];
const cases = starts.flatMap((start, i) => [-1, 1].map(side => ({ start, side, split: 'train', seed: 100 + i * 2 + (side > 0 ? 1 : 0) })));
cases.push(...(warm ? [480, 925, 1420, 1780, 2000, 2320] : [250, 875, 1420, 2120]).flatMap((start, i) => [-1, 1].map(side => ({ start, side, split: 'validation', seed: 200 + i * 2 + (side > 0 ? 1 : 0) }))));
for (const c of cases) {
  // A reset car has no settled cornering tyre state. Use upcoming road
  // curvature as well as the current point; a straight just before turn-in
  // must not be initialized at a speed intended for the whole straight.
  const curvature = Math.max(.0001, ...Array.from({ length: 15 }, (_, i) => Math.abs(track.at(c.start + i * 10).curvature)));
  const speed = Math.max(18, Math.min(45, Math.sqrt(8 / curvature)));
  const episode = `${name}-recovery-${c.seed}`;
  const r = spawnSync(process.execPath, ['--import', './scripts/json-loader.mjs', 'subjects/pulse/tools/record.mjs',
    '--name', episode, '--data-root', 'data/' + name + '/candidates', '--split', c.split, '--mode', 'teacher', '--seconds', String(seconds),
    '--seed', String(c.seed), '--start', String(c.start), '--lateral', String(c.side * (warm ? 1 : 2.5)),
    '--yaw-offset', String(c.side * (warm ? .12 : .06)), '--speed', String(speed),
    ...(warm ? ['--warmup-to-start', '--observation-version', 'pulse-observation-v2'] : [])],
    { cwd: ROOT, encoding: 'utf8', timeout: 90000 });
  if (r.status !== 0) throw Error(r.stderr || r.error || `Recorder exited ${r.status}`);
  const s = JSON.parse(r.stdout.trim());
  console.log(JSON.stringify({ episode, split: c.split, start: c.start, speed: warm ? 'actual warm motion' : speed, rows: s.rows,
    trackLimitSeconds: s.trackLimitSeconds, damage: s.cumulativeDamage, incidents: s.incidents }));
  if (s.trackLimitSeconds || s.cumulativeDamage || s.incidents || s.endedEarly || s.dq) {
    quality.rejected.push({ episode, split: c.split, trackLimitSeconds: s.trackLimitSeconds, damage: s.cumulativeDamage });
  } else {
    const approved = resolve(HOME, 'data', name, c.split); mkdirSync(approved, { recursive: true });
    copyFileSync(resolve(HOME, 'data', name, 'candidates', c.split, episode + '.jsonl'), resolve(approved, episode + '.jsonl'));
    quality.accepted.push({ episode, split: c.split });
  }
  writeFileSync(resolve(HOME, 'data', name, 'quality.json'), JSON.stringify(quality, null, 2));
}
console.log(JSON.stringify({ complete: true, accepted: quality.accepted.length, rejected: quality.rejected.length }));
if (quality.accepted.filter(e => e.split === 'train').length < 16 || quality.accepted.filter(e => e.split === 'validation').length < 4)
  throw Error('Too few clean recoveries; inspect the quality report');
