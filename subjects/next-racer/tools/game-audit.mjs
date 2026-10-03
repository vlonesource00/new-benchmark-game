// Read-only architecture investigation. No new driver, tuning or game writes.
// Run with the repository's JSON compatibility loader on Node versions that
// cannot import the older competitors' JSON syntax directly.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS, COMPOUNDS, calibrate } from '../../../game/core/rules.js';
import { RACE_CLASSES, assignClasses } from '../../../game/core/classes.js';
import { HYBRID, DEPLOY_MODES, fitHybrid, hybridStep } from '../../../game/core/hybrid.js';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { wearGrip } from '../../../game/engine/sim/tyre.js';
import { plain, assignDeep } from '../../../game/bridges/remote-sync.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = (file) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
const sourceFiles = [
  'game/main.js', 'game/core/race.js', 'game/core/classes.js', 'game/core/formation.js',
  'game/core/hybrid.js', 'game/core/strategy.js', 'game/core/rules.js',
  'game/core/weather.js', 'game/core/stewards.js', 'game/core/pit.js',
  'game/core/difficulty.js', 'game/core/async-seats.js', 'game/core/seat-worker.js',
  'game/core/field.js', 'game/core/teams.js', 'game/engine/sim/vehicle.js',
  'game/engine/sim/tyre.js', 'game/engine/sim/track.js', 'game/engine/sim/car-specs.js',
  'subjects/solstice/src/driver.js', 'subjects/solstice/src/traffic.js',
  'subjects/solstice/src/path.js', 'subjects/solstice/src/policy.js',
  'subjects/solstice/src/plant.js', 'subjects/solstice/config.json',
  'subjects/solstice/data/lines.json', 'subjects/next-racer/tools/game-audit.mjs',
  'subjects/claude-revolution/ARCHITECTURE.md',
  'subjects/claude-revolution/tools/bench-pace.mjs'
];
const hashes = Object.fromEntries(sourceFiles.map((file) => [file,
  createHash('sha256').update(readFileSync(new URL(`../../../${file}`, import.meta.url))).digest('hex')]));
const gitHead = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`,
  'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const team = () => ({ id: 'audit', name: 'AUDIT', short: 'AUD', color: '#fff',
  index: 0, starter: 0, grid: 0, classId: 'lmdh', raceClass: 'gtp',
  drivers: [{ id: 'solstice', name: 'AUDIT', short: 'AUD', kind: 'ai' }] });

function contextObservation(session) {
  let observed = null, primed = null;
  const race = new EnduranceRace({ track: new Track('harbor-ring'), teams: [team()],
    format: FORMATS.classic, laps: 12, session, weather: 'rain', seed: 7,
    makeBridge: () => ({
      update(car, cars, dt, context) {
        observed ??= { keys: Object.keys(context).sort(), mode: context.mode,
          paceObjective: context.paceObjective, time: context.time, dt,
          hybridModeBeforeHostPolicy: car.hybrid?.mode };
        car.controls = { throttle: 1, brake: 0, steer: 0 };
      },
      prime(car, cars, context) { primed ??= { time: context.time, mode: context.mode }; },
      reset() {}, errors: 0
    }) });
  race.start();
  for (let steps = 0; race.phase === 'countdown' && steps < 600; steps++) race.step(FIXED_DT);
  race.step(FIXED_DT);
  return { session, observed, primed, snapshotSession: race.snapshot().session,
    carGhostAfterStep: race.cars[0].ghost,
    hybridModeAfterHostPolicy: race.cars[0].hybrid?.mode,
    hostAmbient: race.track.ambient, workerTrackDefaultAmbient: new Track('harbor-ring').ambient };
}

function hybridObservation() {
  const track = new Track('harbor-ring');
  const observed = new Vehicle(0, 'AUDIT', '#fff', 'lmdh');
  observed.place(track, 250, 0, 45);
  observed.gear = 5; observed.automatic = true;
  fitHybrid(observed, 0.6);
  observed.controls = { throttle: 1, brake: 0, steer: 0 };
  hybridStep(observed, FIXED_DT);
  const initialForce = observed.hybridForce;
  const snapshot = plain(observed);
  delete snapshot.spec; // Like the worker: reconstruct the immutable class spec.
  const native = assignDeep(new Vehicle(0, 'NATIVE', '#fff', 'lmdh'), snapshot);
  const frozen = assignDeep(new Vehicle(0, 'FROZEN', '#fff', 'lmdh'), plain(snapshot));
  native.controls = frozen.controls = { throttle: 0, brake: 0, steer: 0 };
  // Every forecast owns its tyre and energy state; imagined slip never deposits
  // rubber onto the real surface. Only native changes its private hybrid store.
  const predictionTrack = Object.create(track);
  predictionTrack.deposit = () => {};
  hybridStep(native, FIXED_DT);
  const forceOnLift = native.hybridForce;
  const nativeEnergyAfterLift = native.hybrid.energy;
  native.step(FIXED_DT, predictionTrack);
  frozen.step(FIXED_DT, predictionTrack);
  return { fixture: '45 m/s, gear 5, 60% charge, balanced; full throttle then lift',
    observedForceN: initialForce, nativeForceAfterLiftN: forceOnLift,
    frozenForceAfterLiftN: frozen.hybridForce,
    nativeEnergyAfterLiftJ: nativeEnergyAfterLift, frozenEnergyJ: frozen.hybrid.energy,
    oneStepWorldVelocityDifferenceMps: Math.hypot(frozen.vx - native.vx, frozen.vz - native.vz),
    independentEnergy: native.hybrid !== observed.hybrid,
    independentTyres: native.wheels.every((w, i) => w.tyre !== observed.wheels[i].tyre),
    observedEnergyUnchangedJ: observed.hybrid.energy };
}

function rollingObservation() {
  let race, resets = 0, calls = 0, beforeGreenCalls = 0;
  let firstCall = null, previousTime = null, duplicateTimes = 0;
  race = new EnduranceRace({ track: new Track('harbor-ring'), teams: [team()],
    format: FORMATS.classic, laps: 12, startType: 'rolling',
    makeBridge: () => ({
      update(car, cars, dt, context) {
        calls++; beforeGreenCalls += Number(Boolean(race.formation));
        duplicateTimes += Number(previousTime === context.time);
        previousTime = context.time;
        firstCall ??= { time: context.time, speed: car.speed, mode: context.mode,
          contextKeys: Object.keys(context).sort(), formationStillOwnsCar: Boolean(race.formation) };
        car.controls = { throttle: 0.5, brake: 0, steer: 0 };
      },
      reset() { resets++; }, errors: 0
    }) });
  race.start();
  const initial = { phase: race.phase, time: race.time, progress: race.cars[0].race.progress,
    speed: race.cars[0].speed, hasFormation: Boolean(race.formation) };
  race.step(FIXED_DT);
  const firstFormationMode = race.cars[0].hybrid.mode;
  while (race.formation && race.time < 90) race.step(FIXED_DT);
  return { fixture: 'single GTP, Harbor, default clear weather, native rolling autopilot',
    initial, firstFormationMode, firstCall, resets, calls, beforeGreenCalls,
    duplicateUpdateTimestamps: duplicateTimes, greenAt: race.greenAt,
    formationCompleted: !race.formation, contacts: race.contacts,
    observationLimit: 'contract smoke only, not a field formation or new-driver performance test' };
}

const seat = source('game/core/seat-worker.js'), asyncSeats = source('game/core/async-seats.js');
const main = source('game/main.js'), runner = source('scripts/sim-endurance.mjs');
const nextTeam = team(); nextTeam.drivers[0].id = 'next-racer';
const remapped = assignClasses([nextTeam], 'gtp', 'gtp', () => 0);
const track = new Track('harbor-ring');
const report = {
  purpose: 'Observed game contracts and isolated hybrid transition; no lap-time or new-AI claims',
  gitHead, node: process.version, sourceHashes: hashes,
  harbor: { lengthM: track.length, roadWidthM: track.width, curbWidthM: track.curbWidth,
    centerlineMeanSpeedAt53sMps: track.length / 53,
    centerlineMeanSpeedAt64sMps: track.length / 64 },
  contexts: ['race', 'qualifying'].map(contextObservation),
  rollingStart: rollingObservation(),
  transportSourceObservations: {
    seatRebuildsContextAsRace: seat.includes("mode: 'race'"),
    seatRaceShimHasEntryOf: /\bentryOf\s*\(/.test(seat),
    seatRaceShimHasCalibration: /\bcal\s*:/.test(seat),
    postsWetness: asyncSeats.includes('wetness: race.track.wetness'),
    postsTempGrip: asyncSeats.includes('tempGrip: race.track.tempGrip'),
    postsAmbient: /ambient\s*:/.test(asyncSeats),
    postsRaceSession: /session\s*:/.test(asyncSeats),
    postsFormationStatus: /formation\s*:/.test(asyncSeats),
    postsSnapshotTime: asyncSeats.includes('time: context.time'),
    capsPostedDtAt100ms: asyncSeats.includes('Math.min(0.1, this.pendingDt)'),
    browserUsesNearFixedSubsteps: main.includes('dt = total / n'),
    browserRandomisesChangeableWeatherSeed: /weatherSeed:\s*setup\.weather\s*===\s*'changeable'\s*\?\s*\(Math\.random\(\)/.test(main),
    standardRunnerPassesWeatherOptionToRace: /new EnduranceRace\(\{[^}]*weather/s.test(runner)
  },
  registration: { prototypeAllowedDrivers: RACE_CLASSES.gtp.ai,
    unregisteredNewDriverAfterClassAssignment: remapped[0].drivers[0].id },
  hybrid: { capacityJ: HYBRID.capacity, regenKw: HYBRID.regenKw,
    efficiency: HYBRID.efficiency, modes: DEPLOY_MODES, transition: hybridObservation() },
  endurance: Object.fromEntries([6, 12, 20].map(laps => [laps, calibrate(track, laps)])),
  compounds: COMPOUNDS,
  wearGrip: Object.fromEntries([0, 0.12, 0.72, 0.75, 0.95, 1].map(w => [w, wearGrip(w)]))
};
console.log(JSON.stringify(report, null, 2));
