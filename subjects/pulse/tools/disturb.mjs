// Bounded CPU-parallel correction collection. External steering pulses are
// teacher-only training state generation, never reported as PULSE performance.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, HOME } from './versions.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name'), jobs = +arg('jobs', 4), seconds = +arg('seconds', 120);
const pedals = args.includes('--pedals');
if (!name || !/^[a-z0-9-]+$/i.test(name) || !Number.isInteger(jobs) || jobs < 1 || jobs > 8 || seconds < 10 || seconds > 240) throw Error('Use a new name, 1–8 jobs and bounded duration');
const output = resolve(HOME, 'data', name);
if (existsSync(output)) throw Error('Dataset exists; preserve it');
mkdirSync(output, { recursive: true });
const cases = [0, 1, 2, 3].flatMap(i => (pedals ? [.25, .5, .8] : [.06, .12, .20]).map((amplitude, j) => ({ seed: (pedals ? 600 : 300) + i * 3 + j,
  split: i < 3 ? 'train' : 'validation', amplitude, period: 2 + i * .45, duration: pedals ? .25 + j * .125 : .12 + j * .06 })));
const report = { name, seconds, jobs, actuator: pedals ? 'longitudinal' : 'steer', cases: [], scope: 'Corrective training states; no policy evaluation or competitive claim.' };
let next = 0;
async function worker() {
  while (next < cases.length) {
    const c = cases[next++], episode = `${name}-${c.seed}`;
    const command = ['--import', './scripts/json-loader.mjs', 'subjects/pulse/tools/record.mjs', '--name', episode, '--data-root', 'data/' + name,
      '--split', c.split, '--mode', 'teacher', '--seconds', String(seconds), '--seed', String(c.seed),
      pedals ? '--disturbance-longitudinal' : '--disturbance-steer', String(c.amplitude), '--disturbance-period', String(c.period), '--disturbance-duration', String(c.duration),
      '--observation-version', 'pulse-observation-v2'];
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, command, { cwd: ROOT, windowsHide: true });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill(), 180000);
      child.stdout.on('data', text => stdout += text); child.stderr.on('data', text => stderr += text);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? done(JSON.parse(stdout.trim())) : reject(Error(stderr || `Recorder exited ${code}`)); });
    });
    const row = { ...c, episode, rows: result.rows, seconds: result.seconds, damage: result.cumulativeDamage,
      trackLimitSeconds: result.trackLimitSeconds, fullLaps: result.fullLaps, endedEarly: result.endedEarly, dq: result.dq };
    report.cases.push(row); console.log(JSON.stringify(row));
    writeFileSync(resolve(output, 'quality.json'), JSON.stringify(report, null, 2));
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, cases.length) }, worker));
console.log(JSON.stringify({ complete: true, episodes: report.cases.length }));
