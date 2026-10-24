// Short, isolated encounters through the real async-seat protocol. One child
// process at a time, below-normal priority; no GPU or learned-policy training.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { bodyClearance, scoreCombat, classifyContact } from './combat-metrics.mjs';

const args = process.argv.slice(2), flag = (k, d) => {
  const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1];
};
const root = fileURLToPath(new URL('../../../', import.meta.url));
const resultsDir = fileURLToPath(new URL('../results/', import.meta.url));

export const combatCases = [
  { id: 'harbor-equal-straight', track: 'harbor-ring', s: 250, kind: 'equal', rival: 'intercept' },
  { id: 'harbor-equal-corner', track: 'harbor-ring', s: 1350, kind: 'equal', rival: 'razor' },
  { id: 'solenne-equal-entry', track: 'solenne', s: 1100, kind: 'equal', rival: 'intercept' },
  { id: 'solenne-equal-exit', track: 'solenne', s: 2300, kind: 'equal', rival: 'razor' },
  { id: 'harbor-momentum', track: 'harbor-ring', s: 250, kind: 'momentum', rival: 'razor' },
  { id: 'solenne-momentum', track: 'solenne', s: 2300, kind: 'momentum', rival: 'intercept' },
  { id: 'harbor-worn-traffic', track: 'harbor-ring', s: 250, kind: 'traffic', rival: 'intercept' },
  { id: 'solenne-worn-traffic', track: 'solenne', s: 2300, kind: 'traffic', rival: 'razor' },
  { id: 'harbor-backmarker', track: 'harbor-ring', s: 250, kind: 'backmarker', rival: 'intercept', egoClass: 'lmdh' },
  { id: 'solenne-backmarker', track: 'solenne', s: 2300, kind: 'backmarker', rival: 'razor', egoClass: 'lmdh' },
  { id: 'harbor-doors-attack', track: 'harbor-ring', s: 250, kind: 'doors-attack', rival: 'razor', doors: true, duration: 35 },
  { id: 'solenne-doors-attack', track: 'solenne', s: 2300, kind: 'doors-attack', rival: 'intercept', doors: true, duration: 35 },
  { id: 'harbor-doors-defend', track: 'harbor-ring', s: 250, kind: 'doors-defend', rival: 'razor', doors: true, duration: 35 },
  { id: 'solenne-doors-defend', track: 'solenne', s: 1100, kind: 'doors-defend', rival: 'intercept', doors: true, duration: 35 },
  { id: 'harbor-defend', track: 'harbor-ring', s: 250, kind: 'defend', rival: 'razor' },
  { id: 'solenne-defend', track: 'solenne', s: 1100, kind: 'defend', rival: 'intercept' },
  { id: 'harbor-brake', track: 'harbor-ring', s: 250, kind: 'brake', rival: 'intercept' },
  { id: 'solenne-brake', track: 'solenne', s: 2300, kind: 'brake', rival: 'razor' }
];

async function runCase({ driver, scene, seed, options, trace, solo = false }) {
  const { Track } = await import('../../../game/engine/sim/track.js');
  const { EnduranceRace, FIXED_DT } = await import('../../../game/core/race.js');
  const { FORMATS } = await import('../../../game/core/rules.js');
  const { AsyncSeats } = await import('../../../game/core/async-seats.js');
  const { installWorkerShim } = await import('../../../scripts/bench/lockstep-workers.mjs');
  const { Course } = await import('../src/course.js');
  const { settingsFor } = await import('../src/settings.js');
  const { VanguardDriver } = await import('../src/driver.js');
  const { gap } = await import('../src/math.js');
  if (Object.keys(options).length) {
    const prepare = VanguardDriver.prototype.prepare;
    VanguardDriver.prototype.prepare = function(car) { prepare.call(this, car); Object.assign(this.options, options); };
    if (driver === 'counterpoint') Object.assign((await import('../../counterpoint/src/driver.js')).DEFAULTS, options);
  }
  const shim = installWorkerShim({ frameSteps: 2, seed });
  const track = new Track(scene.track), seats = new AsyncSeats(scene.track), cls = 'gt';
  const ids = solo ? [scene.rival] : [scene.rival, driver], egoIndex = solo ? 0 : 1;
  const teams = ids.map((id, i) => ({ id: 'combat' + i, name: id, short: id.slice(0, 3),
    color: i ? '#00f5d4' : '#f60', index: i, grid: i, starter: 0,
    classId: !solo && i === egoIndex ? scene.egoClass ?? cls : cls,
    raceClass: !solo && i === egoIndex && scene.egoClass === 'lmdh' ? 'gtp' : 'gt3',
    drivers: [{ id, name: id, short: id.slice(0, 3), kind: 'ai' }] }));
  const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false },
    laps: 20, startCompound: 'soft', startType: 'standing', seed, weatherSeed: seed, weather: 'clear',
    difficulty: 1, makeBridge: seats.factory() });
  seats.wantDebug = trace;
  try {
    const ready = seats.start(race); await shim.settle(); await ready;
    race.start();
    while (race.phase !== 'racing') { race.step(FIXED_DT); shim.step(); }
    const settings = settingsFor(scene.track), course = new Course(track, { ...settings, ...settings.perClass.gt });
    // One GT reference sets both fixtures, including an LMDh ego's control.
    // The rival-only control must start at exactly the same pose and speed.
    course.prepare(race.cars[0]);
    const defending = scene.kind === 'defend' || scene.kind === 'doors-defend',
      separation = scene.doors ? (defending ? -1 : 1) : defending ? -10 : scene.kind === 'brake' ? 16 : scene.attackGap ?? 14;
    // Include both stations in the speed calculation even for the rival-only
    // control, so its initial speed exactly matches the paired encounter.
    const roads = [scene.s + separation, scene.s], cursors = roads.map(s => {
      let i = 0, error = Infinity;
      for (let j = 0; j < course.line.N; j++) {
        const d = Math.abs(gap(course.line.st[j], s, track.length)); if (d < error) { error = d; i = j; }
      }
      return i;
    });
    const speed = Math.min(42, ...cursors.map(i => course.line.vbrk[i] * 0.86));
    const initial = [];
    for (const [i, car] of race.cars.entries()) {
      const state = car.race, c = cursors[i];
      const velocity = speed + (!solo && ['momentum', 'doors-attack'].includes(scene.kind) && i === egoIndex ? 2 : defending && i === 0 ? 2 : 0);
      const lateral = course.line.lat[c] + (!solo && scene.doors && i === egoIndex ?
        (course.line.lat[c] >= 0 ? -2.08 : 2.08) : 0);
      car.place(track, roads[i], lateral, velocity);
      car.race = { ...state, lap: 1, progress: roads[i], previousS: roads[i], lapStart: race.time, valid: true, offtrack: 0 };
      car.fuel = 60;
      let model = course.model;
      if (car.classId !== cls) {
        const ownSettings = settingsFor(scene.track), ownCourse = new Course(track, { ...ownSettings, ...ownSettings.perClass[car.classId] });
        ownCourse.prepare(car); model = ownCourse.model;
      }
      car.gear = model.gearAt(velocity, 4);
      car.yaw = course.line.h[c]; car.vx = Math.sin(car.yaw) * velocity; car.vz = Math.cos(car.yaw) * velocity;
      race.fitTyres(car, 'soft', true);
      for (const w of car.wheels) w.tyre.wear = scene.kind === 'traffic' && i === 0 ? 0.7 : 0;
      race.entries[i].strategist.decide = () => null;
      initial.push({ id: ids[i], classId: car.classId, s: roads[i], lateral, speed: velocity, fuel: car.fuel,
        tyres: car.wheels.map(w => ({ compound: w.tyre.compound, wear: w.tyre.wear, core: w.tyre.core })) });
    }
    // Both cars must be in their final fixture state before either worker is reset.
    for (const entry of race.entries) for (const bridge of entry.bridges) bridge.reset?.({ cars: race.cars, track });
    if (!solo && bodyClearance(race.cars[0], race.cars[1]) < (scene.doors ? 0.005 : 0.2)) throw Error('Fixture begins with overlapping bodies');
    if (scene.kind === 'brake') for (const bridge of race.entries[0].bridges) {
      const update = bridge.update.bind(bridge), brakeAt = race.time + 1.5;
      bridge.update = (car, ...rest) => { update(car, ...rest);
        if (race.time >= brakeAt && race.time < brakeAt + 0.7) car.controls = { ...car.controls, throttle: 0, brake: 0.7 };
      };
    }
    const started = race.time, startedContacts = race.contacts, startedSevere = race.collisionStats.severeContacts,
      duration = scene.duration ?? (scene.kind === 'brake' ? 18 : 25);
    const summaries = race.cars.map(() => ({ damage: 0, offtrack: 0, teleported: false, errors: 0, retired: false, progress: 0 }));
    const origin = race.cars.map(c => c.race.progress), last = race.cars.map(c => ({ x: c.x, z: c.z, damage: c.damage }));
    const rows = []; let clearSeconds = 0, touchSeconds = 0, contactSeconds = 0, lastTrace = -Infinity, minClearance = Infinity;
    const contactKinds = { rubs: 0, nose: 0, rear: 0, other: 0, severe: 0, peakClosing: 0 }, contactEvents = [];
    const pairs = race.collisionStats.pairs;
    pairs.push = function(...events) {
      for (const [a, b, closing] of events) {
        if (solo || (a !== egoIndex && b !== egoIndex)) continue;
        const type = classifyContact(race.cars[egoIndex], race.cars[a === egoIndex ? b : a], closing);
        if (contactEvents.length < 64) contactEvents.push({ t: race.time - started, a, b, ...type });
        contactKinds.rubs += Number(type.rub); contactKinds.nose += Number(type.nose);
        contactKinds.rear += Number(type.rear); contactKinds.other += Number(!type.rub && !type.nose && !type.rear);
        contactKinds.severe += Number(type.severe); contactKinds.peakClosing = Math.max(contactKinds.peakClosing, closing);
      }
      return Array.prototype.push.apply(this, events);
    };
    while (race.time < started + duration) {
      const contacts = race.contacts;
      race.step(FIXED_DT); shim.step();
      for (const [i, car] of race.cars.entries()) {
        const row = summaries[i], prev = last[i];
        row.damage += Math.max(0, car.damage - prev.damage);
        row.offtrack = Math.max(row.offtrack, car.race.offtrack);
        row.teleported ||= Math.hypot(car.x - prev.x, car.z - prev.z) > 5;
        row.retired ||= Boolean(car.race.retired || car.race.dq || car.race.finishTime !== null);
        row.progress = car.race.progress - origin[i];
        Object.assign(prev, { x: car.x, z: car.z, damage: car.damage });
      }
      const clearance = solo ? Infinity : bodyClearance(race.cars[0], race.cars[egoIndex]);
      minClearance = Math.min(minClearance, clearance);
      if (clearance <= 0.002) touchSeconds += FIXED_DT;
      if (race.contacts > contacts) contactSeconds += FIXED_DT;
      const finalGap = solo ? 0 : race.cars[0].race.progress - race.cars[egoIndex].race.progress;
      clearSeconds = finalGap < -5.6 ? clearSeconds + FIXED_DT : 0;
      if (trace && race.time - lastTrace >= 0.1) {
        lastTrace = race.time;
        rows.push({ t: race.time - started, gap: finalGap, clearance, contacts: race.contacts - startedContacts,
          cars: race.entries.map(e => ({ s: e.car.s, x: e.car.x, z: e.car.z, yaw: e.car.yaw,
            speed: e.car.speed, controls: { ...e.car.controls }, damage: e.car.damage,
            debug: structuredClone(e.bridges[e.active]?.debug?.()) })) });
      }
    }
    for (const [i, entry] of race.entries.entries()) summaries[i].errors = entry.bridges.reduce((n, b) => n + (b.errors ?? 0), 0);
    const result = { driver, control: solo, scene: scene.id, track: scene.track, kind: scene.kind,
      mode: defending ? 'defend' : scene.kind === 'brake' ? 'brake' : 'attack', seed, options, initial,
      seconds: race.time - started, ego: summaries[egoIndex], rival: summaries[0], contacts: race.contacts - startedContacts,
      severe: race.collisionStats.severeContacts - startedSevere, touchSeconds, contactSeconds, minClearance, clearSeconds,
      contactKinds, contactEvents, damageCap: 0.01,
      finalGap: race.cars[0].race.progress - race.cars[egoIndex].race.progress };
    return { ...result, score: scoreCombat(result), trace: trace ? rows : undefined };
  } finally { seats.dispose(); }
}

if (args[0] === '--run') {
  const started = performance.now();
  const result = await runCase(JSON.parse(args[1]));
  console.log(JSON.stringify({ ...result, wallSeconds: (performance.now() - started) / 1000 }));
} else {
  const drivers = flag('drivers', 'vanguard,intercept,razor,apex,tempest').split(',');
  const seeds = flag('seeds', '7').split(',').map(Number), only = flag('only', '').split(',').filter(Boolean);
  const stationOffset = +flag('station-offset', 0);
  const attackGap = +flag('attack-gap', 14);
  if (!Number.isFinite(stationOffset) || Math.abs(stationOffset) > 30) throw Error('Station offset must be within 30 m');
  if (!Number.isFinite(attackGap) || attackGap < 6 || attackGap > 30) throw Error('Attack gap must be within 6..30 m');
  const scenes = (only.length ? combatCases.filter(c => only.includes(c.id)) : combatCases)
    .map(c => ({ ...c, s: c.s + stationOffset,
      ...(!c.doors && ['equal', 'momentum', 'traffic'].includes(c.kind) ? { attackGap } : {}),
      ...(args.includes('--seconds') ? { duration: +flag('seconds', 25) } : {}) }));
  if (only.some(id => !combatCases.some(c => c.id === id))) throw Error('Unknown scene in --only');
  const tag = flag('tag', 'combat-baseline');
  if (!/^[a-zA-Z0-9_-]+$/.test(tag)) throw Error('Unsafe report tag');
  const options = JSON.parse(flag('opts', '{}'));
  const hashes = {};
  const sourceDrivers = [...new Set([...drivers, ...scenes.map(c => c.rival), 'vanguard', 'intercept', 'razor', 'apex'])];
  const scope = ['game/core', 'game/bridges', 'game/engine/sim',
    ...sourceDrivers.flatMap(id => [`subjects/${id}/src`, `subjects/${id}/data`])];
  function stamp(dir) {
    try { for (const entry of readdirSync(root + dir, { withFileTypes: true })) {
      const f = dir + '/' + entry.name;
      if (entry.isDirectory()) stamp(f);
      else if (/\.(js|mjs|json)$/.test(f)) hashes[f] = createHash('sha256').update(readFileSync(root + f)).digest('hex');
    } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const dir of scope) stamp(dir);
  for (const f of [...sourceDrivers.map(id => `subjects/${id}/config.json`),
    'scripts/bench/lockstep-workers.mjs', 'scripts/json-loader.mjs',
    'subjects/vanguard/tools/combat-bench.mjs', 'subjects/vanguard/tools/combat-metrics.mjs']) {
    try { hashes[f] = createHash('sha256').update(readFileSync(root + f)).digest('hex'); } catch {}
  }
  const report = { version: 5, scoreContract: 'racing-rub-1pct-per-encounter-v1', defaultClassId: 'gt', drivers, seeds, scenes, stationOffset, attackGap, options, sourceHashes: hashes,
    benchmarkHash: createHash('sha256').update(readFileSync(new URL(import.meta.url)))
      .update(readFileSync(new URL('./combat-metrics.mjs', import.meta.url))).digest('hex'),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    timing: { frameSteps: 2, lagFrames: 0 }, started: new Date().toISOString(), controls: [], cases: [] };
  mkdirSync(resultsDir, { recursive: true });
  const order = args.includes('--controls-only') ? ['_control'] : ['_control', ...drivers];
  for (const driver of order) for (const seed of seeds) for (const scene of scenes) {
    if (driver !== '_control' && report.controls.some(c => c.error || !c.score?.unassisted)) {
      throw Error('A rival failed the solo fixture control; inspect controls before ranking combat.');
    }
    const trace = flag('trace-case', '') === scene.id;
    const data = { driver: driver === '_control' ? scene.rival : driver, scene, seed,
      options: driver === 'vanguard' || driver === 'counterpoint' ? options : {}, trace, solo: driver === '_control' };
    const child = spawn(process.execPath, ['--import', './scripts/json-loader.mjs', fileURLToPath(import.meta.url), '--run', JSON.stringify(data)],
      { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    let out = '', err = '';
    child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => err += chunk);
    const timer = setTimeout(() => child.kill(), 90000);
    const exit = await new Promise(resolve => child.on('close', resolve)); clearTimeout(timer);
    let result;
    try { if (exit !== 0) throw Error(err.slice(-1500)); result = JSON.parse(out.trim().split('\n').at(-1)); }
    catch (error) { result = { driver, scene: scene.id, seed, error: String(error.message) }; }
    if (result.trace) {
      const name = `${tag}-${driver}-${scene.id}-${seed}-trace.json`;
      writeFileSync(resultsDir + name, JSON.stringify(result)); result.traceFile = name; delete result.trace;
    }
    (driver === '_control' ? report.controls : report.cases).push(result); report.finished = new Date().toISOString();
    writeFileSync(resultsDir + tag + '.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ driver, scene: scene.id, seed, error: result.error,
      success: result.score?.success, cleanPass: result.score?.cleanPass, contacts: result.contacts,
      damage: result.ego?.damage, finalGap: result.finalGap, wallSeconds: result.wallSeconds }));
  }
  report.changesDuringRun = Object.entries(hashes).filter(([file, hash]) =>
    createHash('sha256').update(readFileSync(root + file)).digest('hex') !== hash).map(([file]) => file);
  writeFileSync(resultsDir + tag + '.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: resultsDir + tag + '.json', controls: report.controls.length, cases: report.cases.length,
    errors: [...report.controls, ...report.cases].filter(c => c.error).length, changedFiles: report.changesDuringRun }));
}
