// Bounded, resumable comparison campaign. One below-normal child at a time.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { provenance } from './provenance.mjs';

const args = process.argv.slice(2), flag = (key, d) => {
  const i = args.indexOf('--' + key); return i < 0 ? d : args[i + 1];
};
const phase = flag('phase', 'smoke'), prefix = flag('tag', 'cp1');
if (!/^[a-z0-9_-]+$/i.test(prefix)) throw Error('Invalid report tag');
const root = fileURLToPath(new URL('../../../', import.meta.url)), dir = new URL('../results/', import.meta.url);
mkdirSync(dir, { recursive: true });
try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const probe = 'subjects/vanguard/tools/probe.mjs', combat = 'subjects/vanguard/tools/combat-bench.mjs';
const solo = 'subjects/vanguard/tools/matrix.mjs', jobs = [];
const add = (name, script, options) => jobs.push({ name: `${prefix}-${name}`, script, options });
const basic = ['--track', 'harbor-ring', '--cls', 'gt', '--seed', '7', '--time', '150', '--lap-target', '2'];
const tuneScenes = 'harbor-equal-straight,harbor-equal-corner,solenne-equal-entry,solenne-momentum,harbor-worn-traffic,harbor-backmarker,harbor-defend,harbor-brake';
if (phase === 'smoke') {
  add('base', probe, ['--ids', 'vanguard-v2', ...basic]);
  add('ablation', probe, ['--ids', 'counterpoint', ...basic, '--opts', JSON.stringify({ interactive: false })]);
  add('solo', probe, ['--ids', 'counterpoint', ...basic]);
  add('tune-combat', combat, ['--drivers', 'counterpoint,vanguard-v2', '--seeds', '7', '--only', tuneScenes,
    '--seconds', '40', '--tag', `${prefix}-tune-combat`, '--trace-case', 'harbor-equal-corner']);
} else if (phase === 'deep') {
  for (const driver of ['counterpoint', 'vanguard-v2', 'oracle']) {
    add('solo-' + driver, solo, ['--driver', driver, '--seed', '19', '--profile', 'dry', '--out', `${prefix}-solo-${driver}.json`]);
  }
  add('combat-gt', combat, ['--drivers', 'counterpoint,vanguard-v2,oracle,intercept,razor', '--seeds', '19,41',
    '--seconds', '40', '--extra-tracks', '--tag', `${prefix}-combat-gt`]);
  add('combat-gtp', combat, ['--drivers', 'counterpoint,vanguard-v2,oracle', '--class', 'lmdh', '--seeds', '41',
    '--seconds', '40', '--extra-tracks', '--tag', `${prefix}-combat-gtp`]);
  for (const cls of ['gt', 'lmdh']) {
    add('holdout-' + cls, combat, ['--drivers', 'counterpoint,vanguard-v2,oracle', '--class', cls, '--seeds', '79',
      '--only', tuneScenes, '--seconds', '40', '--station-offset', '17', '--attack-gap', '20', '--tag', `${prefix}-holdout-${cls}`]);
    for (const [rotation, ids] of [
      [0, 'counterpoint,vanguard-v2,oracle,intercept,razor,tempest,apex,solstice'],
      [1, 'oracle,intercept,razor,tempest,apex,solstice,counterpoint,vanguard-v2']
    ]) add(`race-${cls}-${rotation}`, probe, ['--ids', ids, '--cls', cls, '--track', 'harbor-ring',
      '--seed', '53', '--race-laps', '5', '--lap-target', '5', '--time', '500', '--out', `${prefix}-race-${cls}-${rotation}.json`]);
  }
  add('mixed-race', probe, ['--ids', 'counterpoint,oracle,vanguard-v2,intercept,razor,tempest',
    '--classes', 'lmdh,lmdh,gt,lmdh,gt,gt', '--track', 'solenne', '--seed', '79',
    '--race-laps', '5', '--lap-target', '5', '--time', '500', '--out', `${prefix}-mixed-race.json`]);
  add('reply-delay', probe, ['--ids', 'counterpoint,vanguard-v2,oracle,intercept', '--track', 'solenne', '--cls', 'gt',
    '--seed', '79', '--lap-target', '3', '--time', '400', '--lagFrames', '1', '--lagJitter', '1', '--frameJitter', '.3',
    '--out', `${prefix}-reply-delay.json`]);
  add('real-worker-latency', 'subjects/counterpoint/tools/latency.mjs', ['--out', `${prefix}-latency.json`]);
} else if (phase === 'grip') {
  for (const profile of ['worn', 'wet']) for (const driver of ['counterpoint', 'vanguard-v2']) {
    add(`${profile}-${driver}`, solo, ['--driver', driver, '--profile', profile, '--seed', '53', '--out', `${prefix}-${profile}-${driver}.json`]);
  }
} else if (phase === 'acceptance') {
  const options = JSON.stringify({ stagedAttacks: true, setupAttacks: true, commitWindow: .35, coastRecovery: true });
  for (const profile of ['dry', 'wet', 'worn']) {
    add('solo-' + profile, solo, ['--driver', 'counterpoint', '--seed', '101', '--profile', profile,
      '--opts', options, '--out', `${prefix}-solo-${profile}.json`]);
  }
  for (const cls of ['gt', 'lmdh']) add('shifted-' + cls, combat,
    ['--drivers', 'counterpoint,oracle', '--class', cls, '--seeds', '79', '--only', tuneScenes,
      '--seconds', '40', '--station-offset', '17', '--attack-gap', '20', '--opts', options,
      '--tag', `${prefix}-shifted-${cls}`]);
  add('latency', 'subjects/counterpoint/tools/latency.mjs', ['--candidate', '--out', `${prefix}-latency.json`]);
} else throw Error('Unknown phase');

const manifest = new URL(`${prefix}-${phase}-jobs.json`, dir);
const source = provenance(), commandSignature = JSON.stringify(jobs);
const report = existsSync(manifest) && args.includes('--resume') ? JSON.parse(readFileSync(manifest, 'utf8')) : {
  phase, prefix, started: new Date().toISOString(), ...source, commandSignature, jobs: []
};
if (report.fingerprint !== source.fingerprint || report.commandSignature !== commandSignature) {
  throw Error('Cannot resume after source or command changes. Use a new --tag to keep results separate.');
}
for (const job of jobs) {
  if (args.includes('--resume') && report.jobs.some(j => j.name === job.name && j.exit === 0)) continue;
  const started = performance.now(), stream = createWriteStream(new URL(job.name + '.log', dir));
  console.log(JSON.stringify({ started: job.name }));
  const child = spawn(process.execPath, ['--import', './scripts/json-loader.mjs', job.script, ...job.options],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30 * 60 * 1000);
  const exit = await new Promise(resolve => { child.on('error', e => { stream.write(String(e)); resolve(-1); }); child.on('close', resolve); });
  clearTimeout(timer); stream.end();
  const row = { ...job, exit, timedOut, wallSeconds: (performance.now() - started) / 1000, finished: new Date().toISOString() };
  report.jobs.push(row); report.updated = row.finished;
  writeFileSync(manifest, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ finished: job.name, exit, timedOut, wallSeconds: row.wallSeconds }));
  if (exit !== 0 && phase === 'smoke') process.exitCode = 1;
}
