// Unassisted traffic collection: the expert labels PULSE's visited states but
// never drives it. Severe/unknown contact and illegal states end training;
// explicitly verified light side brushes can remain eligible when requested.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, ROOT } from './versions.mjs';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name'), model = arg('model'), seconds = +arg('seconds', 45), jobs = +arg('jobs', 6);
const allowLightRubTraining = args.includes('--allow-light-rub-training');
if (!name || !/^[a-z0-9-]+$/i.test(name) || !model || !Number.isInteger(jobs) || jobs < 1 || jobs > 8 || !Number.isFinite(seconds) || seconds < 20 || seconds > 120)
  throw Error('New name, model, 1–8 jobs and bounded duration required');
const output = resolve(HOME, 'data', name);
if (existsSync(output)) throw Error('Dataset exists; preserve it');
mkdirSync(output, { recursive: true });
const cases = [
  ...[35, 65, 100].flatMap((rivalGap, i) => [-1, 1].map(side => ({ fixture: 'train', rivalGap,
    trainSpacing: 70 + i * 20, rivalOffset: side * .6, lateral: side * .4, speed: 43 + i, split: 'train' }))),
  ...['razor', 'apex', 'solstice', 'next-racer'].map((rival, i) => ({ fixture: 'pair', rival, rivalGap: 30 + i * 10,
    lateral: i % 2 ? -.3 : .3, speed: 45, split: 'train' })),
  ...['stopped', 'spun'].map(fixture => ({ fixture, rivalGap: 65, lateral: .2, speed: 42, split: 'train' })),
  ...[50, 85].map((rivalGap, i) => ({ fixture: 'train', rivalGap, trainSpacing: 90, rivalOffset: i ? -.35 : .35,
    lateral: i ? .25 : -.25, speed: i ? 46 : 44, split: 'validation' })),
  { fixture: 'pair', rival: 'razor', rivalGap: 45, lateral: .15, speed: 44, split: 'validation' },
  { fixture: 'spun', rivalGap: 70, lateral: -.15, speed: 43, split: 'validation' },
  // Append to preserve every previous episode's seed and train/validation role.
  ...['razor', 'apex'].flatMap((rival, i) => [45, 85].map((rivalGap, j) => ({ fixture: 'train', rival,
    rivalGap, trainSpacing: 80 + j * 25, lateral: j ? -.2 : .2, speed: 44 + i, split: 'train' }))),
  ...['razor', 'apex'].map((rival, i) => ({ fixture: 'pair', rival, start: 1200, rivalGap: 40 + i * 15,
    lateral: i ? -.3 : .3, speed: 35, split: 'train' })),
  ...['stopped', 'spun'].map(fixture => ({ fixture, start: 1000, rivalGap: 75, lateral: .15, speed: 35, split: 'train' })),
  { fixture: 'train', rival: 'razor', rivalGap: 60, trainSpacing: 95, lateral: -.1, speed: 44.5, split: 'validation' },
  { fixture: 'train', rival: 'apex', rivalGap: 95, trainSpacing: 105, lateral: .1, speed: 45.5, split: 'validation' }
].map((c, i) => ({ start: 20, ...c, seed: 1400 + i }));
const report = { name, model, seconds, jobs, allowLightRubTraining,
  scope: 'Expert-labelled, unassisted policy data. Full failures remain recorded; only their clean prefix trains.', cases: [] };
let next = 0;
async function worker() {
  while (next < cases.length) {
    const c = cases[next++], episode = `${name}-${c.seed}`;
    const command = ['--import', './scripts/json-loader.mjs', 'subjects/pulse/tools/record.mjs', '--name', episode,
      '--data-root', 'data/' + name, '--mode', 'policy', '--trace-expert', '--clean-prefix-training', '--model', model,
      '--split', c.split, '--seconds', String(seconds)];
    if (allowLightRubTraining) command.push('--allow-light-rub-training');
    for (const key of ['seed', 'fixture', 'start', 'speed', 'lateral', 'rival', 'rivalGap', 'trainSpacing', 'rivalOffset'])
      if (c[key] !== undefined) command.push('--' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), String(c[key]));
    const summary = await new Promise((done, reject) => {
      const child = spawn(process.execPath, command, { cwd: ROOT, windowsHide: true });
      let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill(), 180000);
      child.stdout.on('data', text => stdout += text); child.stderr.on('data', text => stderr += text);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? done(JSON.parse(stdout.trim())) : reject(Error(stderr || `Recorder exited ${code}`)); });
    });
    if (summary.expertRows || summary.expertActuatorRows) throw Error('Unassisted collection used expert actuators');
    const row = { ...c, episode, expertRows: summary.expertRows, expertActuatorRows: summary.expertActuatorRows,
      rows: summary.rows, damage: summary.cumulativeDamage, illegal: summary.trackLimitSeconds,
      passes: summary.retainedPasses, hazards: summary.hazardsCleared, progress: summary.progress };
    report.cases.push(row); writeFileSync(resolve(output, 'quality.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(row));
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, cases.length) }, worker));
console.log(JSON.stringify({ complete: true, episodes: report.cases.length }));
