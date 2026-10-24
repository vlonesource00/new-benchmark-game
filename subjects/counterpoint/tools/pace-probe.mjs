// Bounded engineering calibration, not policy/RL training. Every candidate
// drives the same complete solo race; only legal, damage-free runs can rank.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { settingsFor } from '../src/settings.js';
import { provenance } from './provenance.mjs';

const args = process.argv.slice(2), flag = (k, d) => {
  const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1];
}, cls = flag('class', 'gt'), track = flag('track', 'harbor-ring'), seed = +flag('seed', 101),
  tag = flag('tag', 'pace-probe-' + cls), root = fileURLToPath(new URL('../../../', import.meta.url));
if (!['gt', 'lmdh'].includes(cls) || !/^[a-z0-9_-]+$/i.test(tag)) throw Error('Invalid calibration arguments');
const baseline = settingsFor(track).perClass[cls], candidates = [
  ['control', {}], ['yaw45', { yawGain: .45 }], ['yaw65', { yawGain: .65 }],
  ['yaw100', { yawGain: 1 }], ['yaw120', { yawGain: 1.2 }],
  ['slide2', { slideGain: 2 }], ['slide35', { slideGain: 3.5 }], ['slide7', { slideGain: 7 }],
  ['jerk85', { steerJerk: 85 }], ['jerk110', { steerJerk: 110 }]
], source = provenance(), rows = [];
for (const [id, patch] of candidates) {
  const out = `${tag}-${id}.json`, options = { reachableBaseline: false, perClass: { [cls]: { ...baseline, ...patch } } },
    child = spawn(process.execPath, ['--import', './scripts/json-loader.mjs', 'subjects/counterpoint/tools/traffic.mjs',
      '--solo', '--class', cls, '--track', track, '--seed', String(seed), '--laps', '4',
      '--opts', JSON.stringify(options), '--out', out], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  let error = ''; child.stderr.on('data', x => error += x);
  const exit = await new Promise(resolve => child.on('exit', resolve));
  const reportFile = new URL('../results/' + out, import.meta.url);
  if (!existsSync(reportFile)) throw Error('Calibration child produced no result: ' + error.slice(-1000));
  const report = JSON.parse(readFileSync(reportFile)), car = report.subjects[0],
    eligible = exit === 0 && report.telemetryValid && car.completed && car.lapResults.length === 4 && car.lapResults.every(l => l.valid) &&
      car.damage === 0 && car.offtrackSeconds === 0 && car.errors === 0 && report.changesDuringRun.length === 0;
  const row = { id, patch, eligible, exit, telemetryValid: report.telemetryValid, time: car.timeFromGreen, best: car.bestLap,
    valid: car.lapResults.filter(l => l.valid).length, damage: car.damage, off: car.offtrackSeconds, report: out };
  rows.push(row); console.log(JSON.stringify(row));
}
const result = { ...source, track, cls, seed, candidates: rows,
  ranking: rows.filter(x => x.eligible).toSorted((a, b) => a.time - b.time).map(x => x.id),
  changesDuringRun: Object.keys(source.sourceHashes).filter(f => source.sourceHashes[f] !== provenance().sourceHashes[f]) };
writeFileSync(new URL('../results/' + tag + '.json', import.meta.url), JSON.stringify(result, null, 2));
