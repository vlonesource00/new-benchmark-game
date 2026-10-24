// Matched traffic navigation, independent of self-reported pass counters.
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import { installWorkerShim } from '../../../scripts/bench/lockstep-workers.mjs';
import { classifyContact } from '../../vanguard/tools/combat-metrics.mjs';
import { Course } from '../../vanguard-v2/src/course.js';
import { settingsFor } from '../../vanguard-v2/src/settings.js';
import { CounterpointDriver } from '../src/driver.js';
import { gap } from '../../vanguard-v2/src/math.js';
import { liveGrip } from '../../apex/src/model.js';
import { provenance } from './provenance.mjs';
import { plannerTelemetry } from './traffic-telemetry.mjs';

const args = process.argv.slice(2), flag = (key, d) => {
  const i = args.indexOf('--' + key); return i < 0 ? d : args[i + 1];
};
try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const driver = flag('driver', 'counterpoint'), cls = flag('class', 'gt'), trafficClass = flag('traffic-class', cls),
  trackId = flag('track', 'harbor-ring'), laps = +flag('laps', 4), seed = +flag('seed', 53), solo = args.includes('--solo'),
  diagnosticUntil = +flag('until', Infinity),
  options = { ...JSON.parse(flag('opts', '{}')), ...(args.includes('--staged') ? { stagedAttacks: true } : {}),
    ...(args.includes('--steady') ? { commitWindow: .35 } : {}),
    ...(args.includes('--setup') ? { setupAttacks: true } : {}),
    ...(args.includes('--coast') ? { coastRecovery: true } : {}),
    ...(args.includes('--no-route-escape') ? { routeEscape: false } : {}),
    ...(args.includes('--baseline') ? { interactive: false } : {}) };
if (![cls, trafficClass].every(c => ['gt', 'lmdh'].includes(c))) throw Error('Invalid car class');
if (!Number.isInteger(laps) || laps < 1 || laps > 20 || !Number.isFinite(seed)) throw Error('Invalid race configuration');
if (diagnosticUntil !== Infinity && (!Number.isFinite(diagnosticUntil) || diagnosticUntil < 30 || diagnosticUntil > 3000))
  throw Error('Diagnostic stop time must be 30..3000 seconds');
if (Object.keys(options).length && driver !== 'counterpoint') throw Error('Options apply only to the challenger');
const originalPrepare = CounterpointDriver.prototype.prepare;
CounterpointDriver.prototype.prepare = function(car) {
  if (!this.prepared || this.classId !== car.classId) this.settings = { ...this.settings, ...options };
  return originalPrepare.call(this, car);
};
const source = provenance(), wall = performance.now();
const pool = ['intercept', 'razor', 'apex', 'tempest', 'solstice', 'intercept'], speeds = [.97, .95, .93, .96, .92, .94];
const traffic = solo ? [] : pool.map((id, i) => ({ id: pool[(i + seed) % pool.length], cls: trafficClass, pace: speeds[(i + seed * 2) % speeds.length] })),
  field = traffic.concat(Array.from({ length: solo ? 1 : 2 }, () => ({ id: driver, cls, pace: 1 })));
const teams = field.map((entry, i) => ({ id: 'traffic' + i, index: i, grid: i, starter: 0,
  name: entry.id + i, short: entry.id.slice(0, 3) + i, color: '#00f5d4', classId: entry.cls,
  raceClass: entry.cls === 'gt' ? 'gt3' : 'gtp', drivers: [{ id: entry.id, kind: 'ai', name: entry.id }] }));
const track = new Track(trackId), shim = installWorkerShim({ frameSteps: 2, seed }), seats = new AsyncSeats(trackId);
seats.wantDebug = true;
const race = new EnduranceRace({ track, teams, laps, seed, weatherSeed: seed, weather: 'clear', caution: 'off', difficulty: 1,
  format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, startCompound: 'hard', startType: 'rolling', makeBridge: seats.factory() });
const subjects = Array.from({ length: solo ? 1 : 2 }, (_, k) => traffic.length + k),
  metrics = subjects.map(() => ({ stuckSeconds: 0, besideLiftSeconds: 0,
  attackEpisodes: 0, firstAttackSeconds: null, retainedPasses: 0, contacts: 0, mildRubs: 0, severe: 0, offtrackSeconds: 0,
  stuckByIntent: {}, stuckNoseSeconds: 0, attackReturnTransitions: 0, stagedDecisions: null, setupDecisions: null,
  plannerDecisions: null, plannerSamples: 0, missingPlannerSamples: 0, plannerCounterDrops: 0,
  plannerStaleSeconds: 0, maxPlannerAge: 0, contestedHoldSeconds: 0, returnAlignmentSeconds: 0, roadRejectedPlans: null,
  lapResults: [], invalidations: [] }));
const diagnosticState = subjects.map(() => ({ intent: null, sequence: -1, replyTime: -Infinity, lap: null, valid: true, history: [] }));
const lastOfftrack = subjects.map(() => 0);
const finishSnapshots = subjects.map(() => null);
const pairStates = subjects.map(() => new Map()), events = [];
const collisionPush = race.collisionStats.pairs.push;
race.collisionStats.pairs.push = function(...rows) {
  for (const [a, b, closing] of rows) for (const [k, i] of subjects.entries()) if (i === a || i === b) {
    if (finishSnapshots[k] || race.cars[i].race.finishTime !== null) continue;
    const contact = classifyContact(race.cars[i], race.cars[i === a ? b : a], closing);
    metrics[k].contacts++; metrics[k].mildRubs += Number(contact.rub); metrics[k].severe += Number(contact.severe);
  }
  return collisionPush.apply(this, rows);
};
try {
  const ready = seats.start(race); await shim.settle(); await ready;
  race.start();
  for (const [i, entry] of race.entries.entries()) {
    entry.strategist.decide = () => null; entry.governor.base = field[i].pace;
    race.fitTyres(entry.car, 'hard', true);
    entry.car.fuelScale = race.cal.fuelScale * race.cal.fuelLaps / (laps + 1);
  }
  const settings = settingsFor(trackId), course = new Course(track, { ...settings, ...settings.perClass?.[cls] });
  course.prepare(race.cars[subjects[0]]);
  let green = null, tick = 0;
  const cap = Math.min(diagnosticUntil, 140 * laps * Math.max(1, track.length / 3000) + 200);
  while (race.phase !== 'finished' && race.time < cap && !subjects.every(i => race.cars[i].race.finishTime !== null)) {
    race.step(FIXED_DT); shim.step();
    if (race.formation || (race.phase !== 'racing' && !(green !== null && race.phase === 'finished'))) continue;
    green ??= race.time;
    for (const [k, i] of subjects.entries()) {
      if (finishSnapshots[k]) continue;
      const car = race.cars[i], previous = diagnosticState[k], current = car.race.offtrack;
      metrics[k].offtrackSeconds += Math.max(0, current - lastOfftrack[k]);
      lastOfftrack[k] = current;
      if (previous.valid && !car.race.valid) {
        const road = track.nearest(car.x, car.z), bridge = race.entries[i].bridges[race.entries[i].active], debug = bridge.debug?.();
        metrics[k].invalidations.push({ t: race.time - green, raceTime: race.time, x: car.x, z: car.z,
          lap: car.race.lap, s: road.s,
          lateral: road.lateral, speed: car.speed, controls: { ...car.controls },
          tyreWear: car.wheels.map(w => w.tyre.wear), tyreCore: car.wheels.map(w => w.tyre.core),
          trace: debug?.trace, route: debug?.route, plannerIntent: plannerTelemetry(debug).intent,
          plannerCandidates: debug?.planner?.cands,
          executedTrajectory: bridge.visualDebug?.()?.selectedTrajectory?.points?.map(point => ({
            ...point, road: track.nearest(point.x, point.z) })),
          preceding: args.includes('--trace-solo') ? previous.history.slice() : undefined });
      }
      previous.valid = car.race.valid;
      if (previous.lap !== null && car.race.lap > previous.lap) {
        metrics[k].lapResults.push({ lap: car.race.lap - 1, seconds: car.race.lastLap,
          state: car.race.lastState, valid: car.race.lastState !== 'red' });
      }
      previous.lap = car.race.lap;
      if (race.cars[i].race.finishTime !== null) {
        const debug = race.entries[i].bridges[race.entries[i].active].debug?.();
        metrics[k].plannerAgeAtFinish = Number.isFinite(debug?.replyTime) ? race.time - debug.replyTime : null;
        finishSnapshots[k] = {
        damage: race.cars[i].damage, incidents: race.stewards.of(race.entries[i]).inc,
        progress: race.cars[i].race.progress,
        errors: race.entries[i].bridges.reduce((n, b) => n + b.errors, 0)
        };
      }
    }
    if (++tick % 6) continue;
    const dt = FIXED_DT * 6, road = race.cars.map(car => track.nearest(car.x, car.z));
    for (const [k, i] of subjects.entries()) {
      const car = race.cars[i], metric = metrics[k];
      if (car.race.finishTime !== null) continue;
      let stuck = false, beside = false;
      for (let j = 0; j < race.cars.length; j++) {
        if (i === j) continue;
        if (race.entries[j].pit || race.entries[j].retired || race.cars[j].race.finishTime !== null) {
          const pending = pairStates[k].get(j);
          if (pending) { pending.clear = 0; pending.attack = false; }
          continue;
        }
        const ds = gap(road[j].s, road[i].s, track.length), across = Math.abs(road[j].lateral - road[i].lateral);
        if (j < traffic.length && ds > 5 && ds < 25 && across < 2.6) stuck = true;
        if (Math.abs(ds) < 6 && across > 2.0 && across < 5) beside = true;
        if (j >= traffic.length) continue;
        const book = pairStates[k];
        let state = book.get(j);
        if (!state) { state = { seenAhead: ds > 5.6 && ds < 100, attack: false, clear: 0, counted: false }; book.set(j, state); }
        if (ds > 5.6 && ds < 100) state.seenAhead = true;
        const attack = state.seenAhead && ds > -5.6 && ds < 35 && across > 1.85 && across < 5;
        if (attack && !state.attack) {
          metric.attackEpisodes++;
          metric.firstAttackSeconds ??= race.time - green;
        }
        state.attack = attack;
        const longitudinal = race.cars[j].race.progress - car.race.progress;
        state.clear = state.seenAhead && longitudinal < -5.6 ? state.clear + dt : 0;
        if (state.clear >= 4 && !state.counted) {
          state.counted = true; metric.retainedPasses++;
          events.push({ t: race.time - green, subject: k, rival: j, kind: 'retained-pass' });
        }
      }
      const bridge = race.entries[i].bridges[race.entries[i].active], debug = bridge.debug?.(),
        { interactive, intent } = plannerTelemetry(debug), previous = diagnosticState[k];
      if (args.includes('--trace-solo')) {
        previous.history.push({ t: race.time - green, s: road[i].s, lateral: road[i].lateral,
          yaw: car.yaw, route: debug?.route, plannerIntent: intent,
          trace: { ...debug?.trace }, grip: liveGrip(car), controls: { ...car.controls } });
        if (previous.history.length > 45) previous.history.shift();
      }
      if (stuck) {
        metric.stuckSeconds += dt;
        metric.stuckByIntent[intent] = (metric.stuckByIntent[intent] ?? 0) + dt;
        if (debug?.trace?.source === 'nose') metric.stuckNoseSeconds += dt;
      }
      if (intent === 'RETURN' && ['ATTACK', 'ALONGSIDE'].includes(previous.intent)) metric.attackReturnTransitions++;
      if (debug?.configuration) metric.observedExecutorOptions = { ...debug.configuration };
      if (interactive) {
        if (Number.isFinite(debug?.replyTime) && debug.replyTime > previous.replyTime) metric.plannerSamples++;
        if (Number.isFinite(debug?.replyTime)) {
          const age = race.time - debug.replyTime;
          metric.maxPlannerAge = Math.max(metric.maxPlannerAge, age);
          if (age > .5) metric.plannerStaleSeconds += dt;
          previous.replyTime = debug.replyTime;
        }
        if (Number.isFinite(interactive.stagedAdmissions))
          metric.stagedDecisions = Math.max(metric.stagedDecisions ?? 0, interactive.stagedAdmissions);
        if (Number.isFinite(interactive.setupAdmissions))
          metric.setupDecisions = Math.max(metric.setupDecisions ?? 0, interactive.setupAdmissions);
        if (Number.isFinite(interactive.roadRejections))
          metric.roadRejectedPlans = Math.max(metric.roadRejectedPlans ?? 0, interactive.roadRejections);
        if (Number.isFinite(interactive.decisions)) {
          if (previous.sequence >= 0 && interactive.decisions < previous.sequence) metric.plannerCounterDrops++;
          metric.plannerDecisions = Math.max(metric.plannerDecisions ?? 0, interactive.decisions);
        }
        metric.observedPlannerOptions = {
          stagedAttacks: interactive.stagedEnabled, setupAttacks: interactive.setupEnabled, commitWindow: interactive.commitWindow };
      } else if (driver === 'counterpoint') metric.missingPlannerSamples++;
      if (debug?.trace?.contestedHolds?.length) metric.contestedHoldSeconds += dt;
      if (interactive?.returnAlignmentHeld) metric.returnAlignmentSeconds += dt;
      previous.intent = intent; previous.sequence = interactive?.decisions;
      const current = course.line.closest(car.x, car.z), limit = course.line.sample(course.line.vbrk, current.i, current.f, car.speed * .5);
      if (beside && car.controls.throttle < .7 && car.controls.brake < .05 && car.speed < limit - 2) metric.besideLiftSeconds += dt;
    }
  }
  for (const [k, i] of subjects.entries()) {
    const debug = race.entries[i].bridges[race.entries[i].active].debug?.();
    metrics[k].plannerAgeAtObservationEnd = metrics[k].plannerAgeAtFinish ??
      (Number.isFinite(debug?.replyTime) ? race.time - debug.replyTime : null);
  }
  const order = race.order(), endSource = provenance();
  const report = { harnessVersion: 'fresh-worker-telemetry-v6', driver, cls, trafficClass, track: trackId, laps, seed, solo, options, field,
    telemetryValid: driver !== 'counterpoint' || metrics.every(m => m.plannerSamples > 0 && m.plannerCounterDrops === 0 &&
      m.plannerStaleSeconds === 0 && m.plannerAgeAtObservationEnd !== null && m.plannerAgeAtObservationEnd <= .5),
    diagnosticOnly: Number.isFinite(diagnosticUntil), diagnosticUntil: Number.isFinite(diagnosticUntil) ? diagnosticUntil : null,
    plannerCounterScope: 'Observed through the last delivered worker reply at finish; unique reply timestamps are counted as samples.',
    measurement: 'Matched hard-tyre solo or two rear-start subjects behind six governed real rivals. Same worker-seat delivery model; ORACLE retains its production physics-rate main-thread path. Attack episodes are geometric pull-outs, not intentions. Safety freezes at each subject finish. Compare completed distance before time. No pit calls or cautions.',
    ...source, changesDuringRun: Object.keys(source.sourceHashes).filter(f => source.sourceHashes[f] !== endSource.sourceHashes[f]),
    wallSeconds: (performance.now() - wall) / 1000, time: race.time, events,
    opponents: race.entries.slice(0, traffic.length).map(e => ({ retired: e.retired ?? false, finishTime: e.car.race.finishTime, damage: e.car.damage })),
    subjects: subjects.map((i, k) => ({ ...metrics[k], position: order.indexOf(race.cars[i]) + 1,
      finishTime: race.cars[i].race.finishTime, bestLap: race.cars[i].race.bestLap, damage: finishSnapshots[k]?.damage ?? race.cars[i].damage,
      finishLaps: race.cars[i].race.finishLaps ?? 0,
      completed: !race.entries[i].retired && race.cars[i].race.finishTime !== null && race.cars[i].race.finishLaps >= laps,
      progress: finishSnapshots[k]?.progress ?? race.cars[i].race.progress,
      timeFromGreen: race.cars[i].race.finishTime === null ? null : race.cars[i].race.finishTime - green,
      damageReference20Laps: .2,
      incidents: finishSnapshots[k]?.incidents ?? race.stewards.of(race.entries[i]).inc,
      errors: finishSnapshots[k]?.errors ?? race.entries[i].bridges.reduce((n, b) => n + b.errors, 0) })) };
  const dir = new URL('../results/', import.meta.url); mkdirSync(dir, { recursive: true });
  const out = flag('out', `traffic-${driver}-${cls}-${trafficClass}-${trackId}-${seed}.json`);
  if (!/^[a-z0-9_.-]+$/i.test(out)) throw Error('Invalid output filename');
  writeFileSync(new URL(out, dir), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, sourceHashes: undefined, events: undefined }));
  if (!report.telemetryValid) process.exitCode = 1;
} finally { seats.dispose(); }
