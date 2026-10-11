// Unassisted on-policy corrective collection. Expert commands label visited
// states; they never steer or accelerate the student. Only the clean prefix
// enters training, so repair/rescue states cannot act as recovery evidence.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, ROOT } from './versions.mjs';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name'), model = arg('model'), seconds = +arg('seconds', 120), jobs = +arg('jobs', 4);
if (!name || !/^[a-z0-9-]+$/i.test(name) || !model || !Number.isInteger(jobs) || jobs < 1 || jobs > 8 || !Number.isFinite(seconds) || seconds < 30 || seconds > 240)
  throw Error('New name, model, 1–8 jobs and bounded duration required');
const output = resolve(HOME, 'data', name);
if (existsSync(output)) throw Error('Dataset exists; preserve it');
mkdirSync(output, { recursive: true });
const cases = [
  ...[41, 44, 47].flatMap((speed, i) => [-1, 0, 1].map((lateral, j) => ({ seed: 810 + i * 3 + j, start: 20, speed, lateral, split: 'train' }))),
  ...[34, 39, 44].map((speed, i) => ({ seed: 850 + i, start: 1000, speed, lateral: -.5 + .5 * i, split: 'train' })),
  { seed: 891, start: 20, speed: 43.5, lateral: -.4, split: 'validation' },
  { seed: 892, start: 20, speed: 46.5, lateral: .4, split: 'validation' },
  { seed: 893, start: 1000, speed: 36, lateral: -.4, split: 'validation' },
  { seed: 894, start: 1000, speed: 41, lateral: .4, split: 'validation' }
];
const report = { name, model, seconds, jobs, scope: 'Development training data; expert labels only, no actuator assistance. Clean prefix required.', cases: [] };
let next = 0;
async function worker() {
  while (next < cases.length) {
    const c = cases[next++], episode = `${name}-${c.seed}`;
    const command = ['--import', './scripts/json-loader.mjs', 'subjects/pulse/tools/record.mjs', '--name', episode, '--data-root', 'data/' + name,
      '--mode', 'policy', '--trace-expert', '--clean-prefix-training', '--model', model, '--split', c.split, '--seconds', String(seconds),
      '--seed', String(c.seed), '--start', String(c.start), '--speed', String(c.speed), '--lateral', String(c.lateral), '--fixture', 'solo'];
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, command, { cwd: ROOT, windowsHide: true });
      let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill(), 180000);
      child.stdout.on('data', text => stdout += text); child.stderr.on('data', text => stderr += text);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? done(JSON.parse(stdout.trim())) : reject(Error(stderr || `Recorder exited ${code}`)); });
    });
    if (result.expertRows || result.expertActuatorRows) throw Error('Unassisted collection used expert actuators');
    const row = { ...c, episode, expertRows: result.expertRows, expertActuatorRows: result.expertActuatorRows, rows: result.rows,
      damage: result.cumulativeDamage, trackLimitSeconds: result.trackLimitSeconds, endedEarly: result.endedEarly };
    report.cases.push(row); writeFileSync(resolve(output, 'quality.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(row));
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, cases.length) }, worker));
console.log(JSON.stringify({ complete: true, episodes: report.cases.length }));
