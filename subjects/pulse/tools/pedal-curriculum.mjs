// Training-only curriculum: learned steering visits real states while the
// expert supplies pedals. Final gates always remove both forms of assistance.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, ROOT } from './versions.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name'), model = arg('model'), seconds = +arg('seconds', 120), jobs = +arg('jobs', 4);
if (!name || !/^[a-z0-9-]+$/i.test(name) || !model || !Number.isInteger(jobs) || jobs < 1 || jobs > 8 || seconds < 30 || seconds > 240) throw Error('New name, model, 1–8 jobs and bounded duration required');
const output = resolve(HOME, 'data', name);
if (existsSync(output)) throw Error('Dataset exists; preserve it');
mkdirSync(output, { recursive: true });
const cases = [
  ...[40, 45, 50].flatMap((speed, i) => [-1, 0, 1].map((lateral, j) => ({ seed: 400 + i * 3 + j, speed, lateral, fixture: 'solo', split: 'train' }))),
  ...[42, 47, 52].map((speed, i) => ({ seed: 450 + i, speed, lateral: -.6 + i * .6, fixture: 'solo', split: 'validation' })),
  ...[43, 48].flatMap((speed, i) => [-.5, .5].map((lateral, j) => ({ seed: 500 + i * 2 + j, speed, lateral, fixture: 'train', split: j ? 'validation' : 'train' })))
];
const report = { name, model, seconds, jobs, scope: 'Assisted corrective collection, never independent PULSE driving evidence.', cases: [] };
let next = 0;
async function worker() {
  while (next < cases.length) {
    const c = cases[next++], episode = name + '-' + c.seed;
    const command = ['--import', './scripts/json-loader.mjs', 'subjects/pulse/tools/record.mjs', '--name', episode, '--data-root', 'data/' + name,
      '--mode', 'dagger', '--training-expert-actuator', 'longitudinal', '--expert-mix', '0', '--model', model,
      '--split', c.split, '--seconds', String(seconds), '--seed', String(c.seed), '--speed', String(c.speed), '--lateral', String(c.lateral), '--fixture', c.fixture];
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, command, { cwd: ROOT, windowsHide: true });
      let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill(), 180000);
      child.stdout.on('data', text => stdout += text); child.stderr.on('data', text => stderr += text);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? done(JSON.parse(stdout.trim())) : reject(Error(stderr || `Recorder exited ${code}`)); });
    });
    const row = { ...c, episode, expertRows: result.expertRows, expertActuatorRows: result.expertActuatorRows, rows: result.rows,
      damage: result.cumulativeDamage, trackLimitSeconds: result.trackLimitSeconds, endedEarly: result.endedEarly };
    report.cases.push(row); writeFileSync(resolve(output, 'quality.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(row));
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, cases.length) }, worker));
console.log(JSON.stringify({ complete: true, episodes: report.cases.length }));
