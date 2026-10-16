// Fixed game-scored solo coverage. It reports failures rather than hiding them
// behind best-lap pace, and checkpoints its report after every completed case.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = fileURLToPath(new URL('../results/', import.meta.url));
const driver = flag('driver', 'vanguard'), seed = +flag('seed', 7), profile = flag('profile', 'dry');
const tracks = flag('tracks', 'harbor-ring,solenne,alpine,desert,nurburgring').split(',');
const classes = flag('classes', 'gt,lmdh').split(',');
const start = flag('start', 'rolling');
const profiles = {
  dry: { weather: 'clear', tyres: 'soft', wear: 0 },
  wet: { weather: 'rain', tyres: 'wet', wear: 0 },
  worn: { weather: 'clear', tyres: 'medium', wear: 0.6 }
};
if (!profiles[profile]) throw Error('Unknown profile: ' + profile);
const source = createHash('sha256');
for (const f of readdirSync(new URL('../src/', import.meta.url)).filter(f => f.endsWith('.js')).sort()) {
  source.update(f).update(readFileSync(new URL('../src/' + f, import.meta.url)));
}
source.update(readFileSync(new URL('../config.json', import.meta.url)));
const report = { version: 2, harnessVersion: 'post-start-setup-v2', driver, seed, profile, start, conditions: profiles[profile],
  sourceHash: source.digest('hex'), started: new Date().toISOString(), cases: [] };
report.harnessHash = createHash('sha256').update(readFileSync(new URL('./probe.mjs', import.meta.url)))
  .update(readFileSync(new URL('./matrix.mjs', import.meta.url))).digest('hex');
report.gameRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const name = flag('out', `matrix-${driver}-${profile}-${seed}.json`);
if (name.includes('/') || name.includes('\\')) throw Error('--out must be a filename');
mkdirSync(dir, { recursive: true });
for (const track of tracks) for (const cls of classes) {
  const p = profiles[profile], started = performance.now();
  const command = ['--import', './scripts/json-loader.mjs', 'subjects/vanguard/tools/probe.mjs',
    '--ids', driver, '--track', track, '--cls', cls, '--seed', String(seed),
    '--start', start,
    '--weather', p.weather, '--tyres', p.tyres, '--wear', String(p.wear), '--lap-target', '3',
    '--time', track === 'nurburgring' ? '2400' : '400'];
  if (args.includes('--opts')) command.push('--opts', flag('opts', '{}'));
  try {
    const output = execFileSync(process.execPath, command, { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 3e6 });
    const result = JSON.parse(output.trim().split('\n').at(-1)), car = result.cars[0];
    assert(result.actualStart[0].compounds.every(c => c === p.tyres), 'requested starting compound was applied');
    assert(result.actualStart[0].wear.every(w => Math.abs(w - p.wear) < 1e-10), 'requested starting wear was applied');
    const row = { track, cls, completed: car.laps.length, clean: car.laps.filter(l => l.valid).length,
      best: car.best, damage: car.safety.damageGained, incidents: car.inc,
      bridgeErrors: car.errors.reduce((a, b) => a + b, 0), contacts: result.contacts,
      formationDamage: car.safety.formationDamage, drivingDamage: car.safety.drivingDamage,
      wallSeconds: (performance.now() - started) / 1000, result };
    row.pass = row.completed >= 3 && row.clean === row.completed && row.damage === 0 && row.bridgeErrors === 0;
    report.cases.push(row);
    console.log(JSON.stringify({ ...row, result: undefined }));
  } catch (error) {
    report.cases.push({ track, cls, pass: false, error: String(error.message).slice(0, 1800) });
    console.log(JSON.stringify({ track, cls, error: report.cases.at(-1).error }));
  }
  report.finished = new Date().toISOString();
  writeFileSync(dir + name, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ report: dir + name, passed: report.cases.filter(c => c.pass).length, total: report.cases.length }));
