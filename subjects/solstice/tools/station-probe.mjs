import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT, maxWear } from '../../../game/core/race.js';
import { COMPOUNDS, FORMATS } from '../../../game/core/rules.js';
import { AI_DRIVERS, TEAM_LIVERIES } from '../../../game/core/teams.js';
import { RacingPath } from '../src/path.js';
import { MANAGE_ALIEN, MANAGE_CORE } from '../../../game/core/difficulty.js';

const round = (x, digits = 3) => Number(x.toFixed(digits));
const wrap = (x, n) => ((x % n) + n) % n;
const bucket = () => ({ seconds: 0, idealSeconds: 0, distance: 0,
  speed: 0, reference: 0, target: 0, beta2: 0, maxBeta: 0, qError2: 0,
  maxQError: 0, absSteer: 0, throttle: 0, brake: 0, throttleSeconds: 0,
  rawThrottle: 0, rawBrake: 0, governorK: 0, governorCap: 0, governorCutSeconds: 0,
  activeGovernorCutSeconds: 0, inactiveSpinCutSeconds: 0, driveKappa: 0,
  brakeSeconds: 0, coastSeconds: 0, factor: 0, governorSeconds: 0,
  offtrackSeconds: 0, slipWork: 0, core: 0, surface: 0, wear: 0,
  rotation: 0, rotationSeconds: 0, rotationViolationSeconds: 0,
  wheelSlipWork: [0, 0, 0, 0], wheelAlpha2: [0, 0, 0, 0] });

export function stationProbe({ driver = 'solstice', track = 'harbor-ring', seconds = 240,
  laps = 6, compound = 'medium', seed = 7, weather = 'clear', sun = .6, binMetres = 100 } = {}) {
  const known = AI_DRIVERS.find(d => d.id === driver);
  if (!known) throw new Error(`Unknown driver ${driver}`);
  if (![seconds, laps, seed, sun, binMetres].every(Number.isFinite) || seconds <= 0 || binMetres < 20) throw new Error('Invalid probe configuration');
  if (!Object.hasOwn(COMPOUNDS, compound)) throw new Error(`Unknown compound ${compound}`);
  const options = JSON.parse(process.env.SOLSTICE_OPTIONS ?? '{}');
  const hashes = () => Object.fromEntries(['path', 'policy', 'driver', 'traffic', 'plant'].map(name => [name,
    createHash('sha256').update(readFileSync(new URL(`../src/${name}.js`, import.meta.url))).digest('hex')]));
  const startCodeHashes = hashes();
  const lineDataHash = createHash('sha256').update(readFileSync(new URL('../data/lines.json', import.meta.url))).digest('hex');
  const livery = TEAM_LIVERIES[0], team = { ...livery, id: 'probe-0', index: 0,
    grid: 0, starter: 0, drivers: [0, 1].map(() => ({ ...known, kind: 'ai' })) };
  const race = new EnduranceRace({ track: new Track(track), teams: [team],
    format: laps === 6 ? FORMATS.sprint : laps === 20 ? FORMATS.marathon : FORMATS.classic, laps, startCompound: compound,
    difficulty: 1, weather, seed });
  race.weather.sun = sun; race.weather.apply(race.track);
  const entry = race.entries[0], car = entry.car, completed = [], accumulators = new Map();
  const bins = Math.ceil(race.track.length / binMetres);
  const fallback = driver === 'solstice' ? null : new RacingPath(race.track, { spec: car.spec, ...options.path });
  let nextFallback = 0, lastS = car.s, steps = 0, maxCore = 0, maxSurface = 0, rawControls = null, livePlan = null;
  const patchedPolicies = new Set();
  for (const bridge of entry.bridges) {
    const update = bridge.update;
    bridge.update = function (...args) {
      const result = update.apply(this, args);
      rawControls = { ...args[0].controls };
      return result;
    };
  }
  const rescuer = race.rescue;
  let rescues = 0;
  race.rescue = function (e, dt) {
    const before = e.rescueGhost ?? 0, result = rescuer.call(this, e, dt);
    if ((e.rescueGhost ?? 0) > before + .1) rescues++;
    return result;
  };
  race.start();
  const start = performance.now(), maxSteps = Math.ceil((seconds + 10) / FIXED_DT);
  while (steps++ < maxSteps && race.time + FIXED_DT * .5 < seconds && race.phase !== 'finished') {
    const oldTime = race.time, oldLap = car.race.lap, oldLapStart = car.race.lapStart;
    race.step(FIXED_DT);
    const dt = race.time - oldTime, bridge = entry.bridges[entry.active];
    const brain = bridge.driver, path = brain?.path ?? fallback;
    // The first finish-line crossing starts lap 1 without incrementing its
    // number. Discard grid approach telemetry when its timer starts.
    if (car.race.lap === oldLap && car.race.lapStart > oldLapStart + .01) accumulators.delete(oldLap);
    if (brain?.policy && !patchedPolicies.has(brain.policy)) {
      patchedPolicies.add(brain.policy);
      const control = brain.policy.control;
      brain.policy.control = function (c, p, plan, ...rest) {
        if (c === car) livePlan = { ...plan };
        return control.call(this, c, p, plan, ...rest);
      };
    }
    if (dt > 0 && path?.speed) {
      const s = wrap(car.s, race.track.length), i = Math.min(bins - 1, Math.floor(s / binMetres));
      if (!accumulators.has(oldLap)) accumulators.set(oldLap, Array.from({ length: bins }, bucket));
      const b = accumulators.get(oldLap)[i], point = path.at(s), reference = point.speed;
      const advance = clampAdvance(wrap(s - lastS + race.track.length * .5, race.track.length) - race.track.length * .5);
      const arcScale = path.geometry.ds[point.index] / path.step;
      const beta = Math.atan2(car.v, car.u), qError = car.lateral - point.offset;
      const tyres = car.wheels.map(w => w.tyre), core = tyres.reduce((a, t) => a + t.core, 0) / 4;
      const surface = tyres.reduce((a, t) => a + t.surface, 0) / 4;
      b.seconds += dt; b.idealSeconds += advance * arcScale / Math.max(3, reference); b.distance += advance;
      b.speed += car.speed * dt; b.reference += reference * dt;
      b.target += (brain?.policy?.targetSpeed ?? reference) * dt;
      b.beta2 += beta * beta * dt; b.maxBeta = Math.max(b.maxBeta, Math.abs(beta));
      b.qError2 += qError * qError * dt; b.maxQError = Math.max(b.maxQError, Math.abs(qError));
      b.absSteer += Math.abs(car.controls.steer) * dt;
      b.throttle += car.controls.throttle * dt; b.brake += car.controls.brake * dt;
      b.rawThrottle += (rawControls?.throttle ?? car.controls.throttle) * dt;
      b.rawBrake += (rawControls?.brake ?? car.controls.brake) * dt;
      b.governorK += entry.governor.k * dt;
      b.governorCap += (entry.governor.profile ? entry.governor.cap(s, car.speed) : reference) * dt;
      const cut = rawControls && (rawControls.throttle > car.controls.throttle + .01 || rawControls.brake < car.controls.brake - .01);
      b.governorCutSeconds += cut ? dt : 0;
      b.activeGovernorCutSeconds += cut && entry.governor.active ? dt : 0;
      b.inactiveSpinCutSeconds += cut && !entry.governor.active ? dt : 0;
      const driven = car.spec.drive === 'front' ? 0 : 2;
      b.driveKappa += Math.max(car.wheels[driven].tyre.kappa, car.wheels[driven + 1].tyre.kappa) * dt;
      b.throttleSeconds += car.controls.throttle > .1 ? dt : 0;
      b.brakeSeconds += car.controls.brake > .03 ? dt : 0;
      b.coastSeconds += (livePlan?.coast ?? brain?.selected?.coast) ? dt : 0;
      b.factor += (livePlan?.factor ?? brain?.selected?.factor ?? 1) * dt;
      b.governorSeconds += entry.governor.active ? dt : 0;
      b.offtrackSeconds += Math.abs(car.lateral) > race.track.halfWidth + race.track.curbWidth ? dt : 0;
      b.slipWork += tyres.reduce((a, t) => a + t.slipPower, 0) * dt;
      const rotation = entry.pit ? 0 : (brain?.policy?.lastRotation ?? 0);
      b.rotation += rotation * dt;
      b.rotationSeconds += rotation > .0001 ? dt : 0;
      const rear = tyres.slice(2, 4);
      b.rotationViolationSeconds += rotation > .0001
        && (Math.max(...rear.map(t => t.core)) <= 86 || Math.max(...rear.map(t => t.wear)) <= .12) ? dt : 0;
      tyres.forEach((t, j) => { b.wheelSlipWork[j] += t.slipPower * dt; b.wheelAlpha2[j] += t.alpha * t.alpha * dt; });
      b.core += core * dt; b.surface += surface * dt; b.wear += maxWear(car) * dt;
      maxCore = Math.max(maxCore, ...tyres.map(t => t.core)); maxSurface = Math.max(maxSurface, ...tyres.map(t => t.surface));
    }
    if (fallback && race.time >= nextFallback) { fallback.rebuildEnvelope(car, .93); nextFallback = race.time + .33; }
    lastS = car.s;
    if (car.race.lap > oldLap && oldLap > 0) {
      const rows = (accumulators.get(oldLap) ?? []).map((b, i) => {
        const t = Math.max(1e-9, b.seconds);
        return { from: i * binMetres, to: Math.min(race.track.length, (i + 1) * binMetres),
          seconds: round(b.seconds), idealSeconds: round(b.idealSeconds), lostSeconds: round(b.seconds - b.idealSeconds),
          distance: round(b.distance), speed: round(b.speed / t), reference: round(b.reference / t), target: round(b.target / t),
          betaRms: round(Math.sqrt(b.beta2 / t)), maxBeta: round(b.maxBeta), qErrorRms: round(Math.sqrt(b.qError2 / t)),
          maxQError: round(b.maxQError), absSteer: round(b.absSteer / t), throttle: round(b.throttle / t), brake: round(b.brake / t),
          rawThrottle: round(b.rawThrottle / t), rawBrake: round(b.rawBrake / t), governorK: round(b.governorK / t),
          governorCap: round(b.governorCap / t), governorCutSeconds: round(b.governorCutSeconds),
          activeGovernorCutSeconds: round(b.activeGovernorCutSeconds), inactiveSpinCutSeconds: round(b.inactiveSpinCutSeconds), driveKappa: round(b.driveKappa / t),
          throttleSeconds: round(b.throttleSeconds), brakeSeconds: round(b.brakeSeconds), coastSeconds: round(b.coastSeconds),
          factor: round(b.factor / t), governorSeconds: round(b.governorSeconds), offtrackSeconds: round(b.offtrackSeconds),
          slipWorkKJ: round(b.slipWork / 1000), core: round(b.core / t), surface: round(b.surface / t), wear: round(b.wear / t),
          rotation: round(b.rotation / t, 5), rotationSeconds: round(b.rotationSeconds),
          rotationViolationSeconds: round(b.rotationViolationSeconds),
          wheelSlipWorkKJ: b.wheelSlipWork.map(x => round(x / 1000)), wheelAlphaRms: b.wheelAlpha2.map(x => round(Math.sqrt(x / t), 5)) };
      });
      completed.push({ lap: oldLap, time: car.race.lastLap, state: car.race.lastState,
        clean: ['purple', 'green', 'yellow'].includes(car.race.lastState), steady: oldLap > 1,
        tyresAtLine: car.wheels.map(w => ({ compound: w.tyre.compound, core: w.tyre.core,
          surface: w.tyre.surface, wear: w.tyre.wear, pressure: w.tyre.pressure })),
        liveEnvelopeEstimate: path?.estimatedLapTime ?? null, fuel: car.fuel, maxWear: maxWear(car), rows });
    }
  }
  const codeHashes = hashes();
  return { conditions: { driver, track, seconds, laps, seed, weather, sun, teams: 1, difficulty: 1,
      classId: car.classId, compound, format: race.format.id, fuelLaps: race.cal.fuelLaps,
      tyreLaps: race.cal.tyreLaps, fixedDt: FIXED_DT, binMetres, options,
      codeHashes, startCodeHashes, lineDataHash, codeChangedDuringRun: JSON.stringify(codeHashes) !== JSON.stringify(startCodeHashes),
      config: JSON.parse(readFileSync(new URL('../config.json', import.meta.url))),
      governor: { manageAlien: MANAGE_ALIEN, manageCore: MANAGE_CORE,
        manageFloor: Number(process.env.MANAGE_FLOOR ?? .92), manageGain: Number(process.env.MANAGE_GAIN ?? .004) },
      governorHash: createHash('sha256').update(readFileSync(new URL('../../../game/core/difficulty.js', import.meta.url))).digest('hex'),
      bridgeHash: createHash('sha256').update(readFileSync(new URL('../../../game/bridges/solstice-bridge.js', import.meta.url))).digest('hex'),
      reference: driver === 'solstice' ? 'active driver live path envelope' : 'separate SOLSTICE live reference envelope' },
    wallSeconds: (performance.now() - start) / 1000, completed, rescues,
    offtrackSeconds: car.race.offtrack, stops: entry.strategist.stops, bridgeErrors: entry.bridges.reduce((a, b) => a + (b.errors ?? 0), 0),
    maxCore, maxSurface, contactsFieldWide: race.contacts, end: { time: race.time, s: car.s, lateral: car.lateral,
      speed: car.speed, lap: car.race.lap, progress: car.race.progress, controls: car.controls, rawControls } };
}

function clampAdvance(ds) { return Math.max(0, Math.min(3, ds)); }

const config = JSON.parse(process.env.SOLSTICE_PROBE ?? (process.argv[2]?.startsWith('--') ? '{}' : process.argv[2]) ?? '{}');
const outputAt = process.argv.indexOf('--output');
if (outputAt >= 0) config.output = process.argv[outputAt + 1];
const result = stationProbe(config);
if (config.output) {
  const output = resolve(config.output); mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output, completed: result.completed.map(({ lap, time, clean, state }) => ({ lap, time, clean, state })) }));
} else console.log(JSON.stringify(result));
