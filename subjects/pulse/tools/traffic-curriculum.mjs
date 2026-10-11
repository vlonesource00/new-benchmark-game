// Clean expert traffic/hazard demonstrations. Failed episodes stay quarantined;
// only complete legal, undamaged demonstrations enter the cloning dataset.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, ROOT } from './versions.mjs';
import { Track } from '../../../game/engine/sim/track.js';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name'), seconds = +arg('seconds', 90), jobs = +arg('jobs', 6);
if (!name || !/^[a-z0-9-]+$/i.test(name) || !Number.isInteger(jobs) || jobs < 1 || jobs > 8 || !Number.isFinite(seconds) || seconds < 30 || seconds > 180)
  throw Error('New name, bounded duration and 1–8 jobs required');
const output = resolve(HOME, 'data', name);
if (existsSync(output)) throw Error('Dataset exists; preserve it');
mkdirSync(output, { recursive: true });
const track = new Track('harbor-ring');
const safeSpeed = start => Math.max(18, Math.min(45, Math.sqrt(8 / Math.max(.0001,
  ...Array.from({ length: 15 }, (_, i) => Math.abs(track.at(start + i * 10).curvature))))));
const cases = [
  ...[35, 80, 120].flatMap((rivalGap, i) => [-1, 1].map(side => ({ fixture: 'train', start: 20, speed: 45,
    lateral: side * .7, rivalOffset: side * .8, rivalGap, trainSpacing: 75 + i * 10, split: 'train' }))),
  ...['apex', 'razor', 'solstice', 'next-racer'].map((rival, i) => ({ fixture: 'pair', rival, start: 20, speed: 45,
    lateral: i % 2 ? -.2 : .2, rivalGap: i % 2 ? 65 : 30, split: 'train' })),
  ...[650, 1500].map(start => ({ fixture: 'train', start, speed: safeSpeed(start), rivalGap: 50, split: 'train' })),
  ...['stopped', 'spun'].flatMap(fixture => [20, 650, 1500].map(start => ({ fixture, start, speed: safeSpeed(start), split: 'train' }))),
  ...[120, 900, 1700].map(start => ({ fixture: 'train', start, speed: safeSpeed(start), lateral: .35,
    rivalOffset: -.45, rivalGap: 60, trainSpacing: 95, split: 'validation' })),
  ...['apex', 'razor', 'solstice'].map((rival, i) => ({ fixture: 'pair', rival, start: 20, speed: 44,
    lateral: .4, rivalGap: 45 + i * 10, split: 'validation' })),
  ...['stopped', 'spun'].flatMap(fixture => [400, 1200].map(start => ({ fixture, start, speed: safeSpeed(start), split: 'validation' })))
].map((c, i) => ({ ...c, seed: 1200 + i }));
const report = { name, seconds, jobs, scope: 'INTERCEPT demonstrations, not PULSE wins or pass evidence.', accepted: [], rejected: [] };
let next = 0;
async function worker() {
  while (next < cases.length) {
    const c = cases[next++], episode = `${name}-${c.seed}`;
    const command = ['--import', './scripts/json-loader.mjs', 'subjects/pulse/tools/record.mjs', '--name', episode,
      '--data-root', 'data/' + name + '/candidates', '--mode', 'teacher', '--observation-version', 'pulse-observation-v2',
      '--split', c.split, '--seconds', String(seconds)];
    for (const key of ['seed', 'fixture', 'start', 'speed', 'lateral', 'rival', 'rivalGap', 'trainSpacing', 'rivalOffset'])
      if (c[key] !== undefined) command.push('--' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), String(c[key]));
    const summary = await new Promise((done, reject) => {
      const child = spawn(process.execPath, command, { cwd: ROOT, windowsHide: true });
      let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill(), 180000);
      child.stdout.on('data', text => stdout += text); child.stderr.on('data', text => stderr += text);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? done(JSON.parse(stdout.trim())) : reject(Error(stderr || `Recorder exited ${code}`)); });
    });
    const row = { ...c, episode, damage: summary.cumulativeDamage, illegal: summary.trackLimitSeconds,
      incidents: summary.incidents, passes: summary.retainedPasses, hazards: summary.hazardsCleared };
    const clean = !summary.trackLimitSeconds && !summary.cumulativeDamage && !summary.incidents && !summary.dq && !summary.endedEarly;
    if (clean) {
      const approved = resolve(output, c.split); mkdirSync(approved, { recursive: true });
      copyFileSync(resolve(output, 'candidates', c.split, episode + '.jsonl'), resolve(approved, episode + '.jsonl'));
      report.accepted.push(row);
    } else report.rejected.push(row);
    writeFileSync(resolve(output, 'quality.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ clean, ...row }));
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, cases.length) }, worker));
console.log(JSON.stringify({ complete: true, accepted: report.accepted.length, rejected: report.rejected.length }));
if (report.accepted.filter(c => c.split === 'train').length < 6 || report.accepted.filter(c => c.split === 'validation').length < 2)
  throw Error('Not enough clean traffic demonstrations; inspect the quarantined encounters');
