// Matched solo race screen of the selectable roster; real game seats, no GPU.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { AI_DRIVERS, RACE_AI_DRIVERS } from '../../../game/core/teams.js';

const root = fileURLToPath(new URL('../../../', import.meta.url)), args = process.argv.slice(2),
  flag = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };

async function run({ id, trackId, classId, laps, seed }) {
  if (id === 'slipstream') {
    // The shim imports seat modules in Node's shared module cache. Match the
    // browser worker branch before field.js first imports the actor bridge;
    // otherwise it stages an extra action as if called on the main thread.
    globalThis.WorkerGlobalScope = class WorkerGlobalScope {
      static [Symbol.hasInstance](value) { return value === globalThis; }
    };
  }
  const { Track } = await import('../../../game/engine/sim/track.js');
  const { EnduranceRace, FIXED_DT } = await import('../../../game/core/race.js');
  const { FORMATS } = await import('../../../game/core/rules.js');
  const { AsyncSeats } = await import('../../../game/core/async-seats.js');
  const { installWorkerShim } = await import('../../../scripts/bench/lockstep-workers.mjs');
  // Preload the exact deployed export, not an alternate policy. This avoids
  // timing disk I/O as driving while the synchronous Node loop is running.
  if (id === 'slipstream') {
    const { useWeights } = await import('../../../game/bridges/slipstream-bridge.js');
    const name = trackId === 'nurburgring' ? 'slipstream-nurburgring.json' : 'slipstream.json';
    useWeights(JSON.parse(readFileSync(root + 'subjects/slipstream/policy/' + name)));
  }
  const shim = installWorkerShim({ frameSteps: 2, seed }), track = new Track(trackId), seats = new AsyncSeats(trackId),
    ai = AI_DRIVERS.find(x => x.id === id), teams = [{ id: 'roster0', name: ai.name, short: ai.short,
      color: '#00f5d4', index: 0, grid: 0, starter: 0, classId, raceClass: classId === 'lmdh' ? 'gtp' : 'gt3',
      drivers: [{ kind: 'ai', id, name: ai.name, short: ai.short }] }],
    race = new EnduranceRace({ track, teams, laps, seed, weatherSeed: seed, weather: 'clear', difficulty: 1,
      startCompound: 'soft', startType: 'standing', caution: 'off', makeBridge: seats.factory(),
      format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false } });
  try {
    const ready = seats.start(race); await shim.settle(); await ready;
    await new Promise(resolve => setImmediate(resolve));
    race.start();
    const car = race.cars[0], entry = race.entries[0];
    race.fitTyres(car, 'soft', true); car.fuel = 60; entry.strategist.decide = () => null;
    const initial = { fuel: car.fuel, classId: car.classId, tyres: car.wheels.map(w => ({ ...w.tyre })) };
    let damage = 0, previousDamage = car.damage, previousLap = car.race.lap, offtrack = 0,
      rescues = 0, previousPosition = { x: car.x, z: car.z };
    const completed = [], simCap = Math.max(420, track.length / 18 * laps + 60);
    while (race.phase !== 'finished' && race.time < simCap) {
      race.step(FIXED_DT); shim.step();
      damage += Math.max(0, car.damage - previousDamage); previousDamage = car.damage;
      if (race.phase === 'racing') {
        if (car.race.offtrack > offtrack) offtrack = car.race.offtrack;
        if (Math.hypot(car.x - previousPosition.x, car.z - previousPosition.z) > 5) rescues++;
      }
      previousPosition = { x: car.x, z: car.z };
      if (car.race.lap !== previousLap) {
        completed.push({ lap: previousLap, seconds: car.race.lastLap, state: car.race.lastState,
          valid: !['red', 'pit'].includes(car.race.lastState) });
        previousLap = car.race.lap;
      }
    }
    const errors = entry.bridges.reduce((n, b) => n + (b.errors ?? 0), 0);
    return { id, name: ai.name, workerMode: id === 'slipstream' ? globalThis instanceof WorkerGlobalScope : null,
      initial, phase: race.phase, raceTime: car.race.finishTime,
      finished: car.race.finishLaps === laps && !car.race.dq && !car.race.retired,
      completed, validLaps: completed.filter(x => x.valid).length, best: car.race.bestLap,
      damage, offtrack, rescues, errors, dq: Boolean(car.race.dq), progress: car.race.progress,
      lastError: entry.bridges.find(b => b.lastError)?.lastError ?? null };
  } finally { seats.dispose(); }
}

if (args[0] === '--run') {
  const t = performance.now(), result = await run(JSON.parse(args[1]));
  console.log(JSON.stringify({ ...result, wallSeconds: (performance.now() - t) / 1000 }));
} else {
  os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
  const ids = flag('drivers', RACE_AI_DRIVERS.map(x => x.id).join(',')).split(','),
    trackId = flag('track', 'harbor-ring'), classId = flag('class', 'gt'), laps = Number(flag('laps', 2)),
    seed = Number(flag('seed', 7)), tag = flag('tag', 'current-roster-2026-10-17');
  if (ids.some(id => !AI_DRIVERS.some(x => x.id === id)) || new Set(ids).size !== ids.length)
    throw Error('Choose unique selectable driver IDs');
  if (!/^[a-zA-Z0-9_-]+$/.test(tag) || !Number.isInteger(laps) || laps < 1 || laps > 5)
    throw Error('Invalid report tag or lap count');
  const hashes = {}, mapped = [...new Set(ids.map(x => x === 'gemini-supreme-v4' ? 'gemini-supreme' : x))];
  function stamp(dir) {
    try { for (const e of readdirSync(root + dir, { withFileTypes: true })) {
      const p = dir + '/' + e.name;
      if (e.isDirectory()) stamp(p);
      else if (/\.(js|mjs|json)$/.test(p)) hashes[p] = createHash('sha256').update(readFileSync(root + p)).digest('hex');
    } } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  for (const dir of ['game/core', 'game/bridges', 'game/engine/sim', ...mapped.flatMap(id =>
    ['src', 'data', 'config', 'browser', 'env', 'policy'].map(d => 'subjects/' + id + '/' + d))]) stamp(dir);
  for (const p of [...mapped.map(id => 'subjects/' + id + '/config.json'),
    'scripts/bench/lockstep-workers.mjs', 'scripts/json-loader.mjs', 'subjects/vanguard/tools/roster-bench.mjs']) {
    try { hashes[p] = createHash('sha256').update(readFileSync(root + p)).digest('hex'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const dir = root + 'subjects/vanguard/results/'; mkdirSync(dir, { recursive: true });
  const report = { version: 3, trackId, classId, laps, seed, frameSteps: 2, weather: 'clear',
    start: 'standing', compound: 'soft', fuel: 60, strategy: false, driverIds: ids, sourceHashes: hashes,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    started: new Date().toISOString(), cases: [] };
  // The slower planner goes last; other results remain usable if interrupted.
  for (const id of [...ids.filter(x => x !== 'next-racer'), ...ids.filter(x => x === 'next-racer')]) {
    const child = spawn(process.execPath, ['--import', './scripts/json-loader.mjs', fileURLToPath(import.meta.url),
      '--run', JSON.stringify({ id, trackId, classId, laps, seed })], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    let stdout = '', stderr = '';
    child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
    const timer = setTimeout(() => child.kill(), 300000), exit = await new Promise(resolve => child.on('close', resolve));
    clearTimeout(timer);
    let result;
    try { if (exit !== 0) throw Error(stderr.slice(-1200) || 'process timeout/failure'); result = JSON.parse(stdout.trim().split('\n').at(-1)); }
    catch (e) { result = { id, error: e.message }; }
    report.cases.push(result); report.finished = new Date().toISOString();
    writeFileSync(dir + tag + '.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ id, finished: result.finished, validLaps: result.validLaps, best: result.best,
      raceTime: result.raceTime, damage: result.damage, errors: result.errors, error: result.error, wallSeconds: result.wallSeconds }));
  }
  report.changesDuringRun = Object.entries(hashes).filter(([p, h]) =>
    createHash('sha256').update(readFileSync(root + p)).digest('hex') !== h).map(([p]) => p);
  writeFileSync(dir + tag + '.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: dir + tag + '.json', cases: report.cases.length, changed: report.changesDuringRun }));
}
