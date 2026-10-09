// Native held-cadence audit: separates profile jumps, pedal chatter and tyre
// limits. This is not a browser worker-latency measurement.
import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT, maxWear } from '../../../game/core/race.js';
import { FORMATS, COMPOUNDS, TANK_LITRES } from '../../../game/core/rules.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { createRazorBridge } from '../../../game/bridges/razor-bridge.js';
import { createApexBridge, apexState } from '../../../game/bridges/apex-bridge.js';
import { razorState } from '../../../game/bridges/razor-state.js';
import { installRazorStrategy, RazorStrategist } from '../src/strategy.js';
import { installApexStrategy } from '../../apex/src/strategy.js';

const arg = (key, fallback) => process.argv.find(a => a.startsWith('--' + key + '='))?.slice(key.length + 3) ?? fallback;
const id = arg('driver', 'razor'), classId = arg('class', 'gt'), trackId = arg('track', 'nurburgring');
const compound = arg('compound', 'hard'), laps = Number(arg('laps', '2')), calLaps = Number(arg('cal-laps', '4'));
const hz = Number(arg('hz', '60')), duration = Number(arg('seconds', '2400'));
const options = JSON.parse(arg('options', '{}')), rival = arg('rival', '');
const raceMode = process.argv.includes('--race'), stops = Number(arg('stops', '1'));
assert.ok(['razor', 'apex'].includes(id) && ['lmdh', 'gt'].includes(classId) && COMPOUNDS[compound]);
assert.ok([20, 30, 60, 120].includes(hz) && laps >= 1 && calLaps >= laps && duration > 0);
const ids = rival ? [id, rival] : [id], track = new Track(trackId);
const teams = ids.map((driverId, index) => ({ id: 'audit' + index, index, name: driverId, short: driverId,
  color: '#fff', grid: rival ? 1 - index : index, starter: 0, classId, raceClass: classId === 'gt' ? 'gt3' : 'gtp',
  drivers: Array.from({ length: raceMode ? 2 : 1 }, () => ({ ...AI_DRIVERS.find(d => d.id === driverId), kind: 'ai' })) }));
let next = 0, lastControl = null, lastSample = null, lastPath = null;
let cornerSeconds = 0, throttleSum = 0, brakeSum = 0, throttlePulses = 0, brakePulses = 0, pedalSwitches = 0;
let throttleDirection = 0, brakeDirection = 0, throttleAt = -9, brakeAt = -9, pedal = 'coast';
let targetJumps = 0, pathSwitches = 0, offSeconds = 0, maxError = 0;
const limited = { traction: 0, slipProtection: 0, stability: 0, circle: 0, speedTarget: 0 };
const jumps = [], rows = [], bins = new Map(), offLocations = new Map();
const round = n => Number.isFinite(n) ? +n.toFixed(4) : null;
const race = new EnduranceRace({ track, teams, laps: calLaps, startCompound: compound, difficulty: 1,
  weather: 'clear', caution: 'off', seed: 7,
  format: { ...FORMATS.custom, mandatoryStops: raceMode ? stops : 0, mandatorySwap: raceMode && stops > 0 },
  makeBridge(driver, index, r) {
    if (index) return createSeatBridge(driver, index, r);
    if (raceMode) {
      if (id === 'razor' && process.argv.includes('--legacy-strategy')) {
        if (!(r.entries[index].strategist instanceof RazorStrategist)) {
          r.entries[index].strategist = new RazorStrategist(r.entries[index].strategist, track.id, classId, { currentStints: false });
          r.entries[index].strategist.race = r;
        }
      } else if (id === 'razor') installRazorStrategy(r, r.cars[index]);
      else installApexStrategy(r, r.cars[index]);
    }
    const factory = id === 'razor' ? createRazorBridge : createApexBridge;
    const base = factory({ hostTrack: track, index, options, state: car => id === 'razor' ? razorState(r, car) : apexState(r, car) });
    const update = base.update.bind(base);
    base.update = (car, cars, dt, context) => {
      if (context.time + 1e-8 < next && lastControl) { car.controls = { ...lastControl }; return; }
      const elapsed = lastSample ? context.time - lastSample.time : 1 / hz;
      next = context.time + 1 / hz;
      update(car, cars, elapsed, context); lastControl = { ...car.controls };
      const d = base.driver;
      if (!d?.path) return;
      const q = { time: context.time, s: car.s, v: car.speed, target: d.targetSpeed,
        throttle: car.controls.throttle, brake: car.controls.brake, corner: Math.abs(d.ayReq ?? 0) > 4,
        state: d.combat?.state, share: d.share, tc: d.tcCap, protect: d.protect, stability: d.stability,
        grip: d.model.grip, line: d.path === d.line, pathKind: d.combat?.plan?.kind ?? 'fast line' };
      if (lastPath && lastPath !== d.path) pathSwitches++;
      if (lastSample && Math.abs(q.target - lastSample.target) > 5) {
        targetJumps++;
        if (jumps.length < 12) jumps.push({ t: round(q.time), s: round(q.s), from: round(lastSample.target * 3.6),
          to: round(q.target * 3.6), v: round(q.v * 3.6), before: lastSample.state, state: q.state,
          pathSwitch: lastPath !== d.path, gripDelta: round(q.grip - lastSample.grip), throttle: round(q.throttle), brake: round(q.brake) });
      }
      if (q.corner) {
        cornerSeconds += elapsed; throttleSum += q.throttle * elapsed; brakeSum += q.brake * elapsed;
        for (const [key, value] of [['traction', q.tc], ['slipProtection', q.protect], ['stability', q.stability], ['circle', q.share * (d.options.throttleAllow ?? 1.25)]]) {
          if (q.throttle < .85 && value < .85) limited[key] += elapsed;
        }
        if (q.target < q.v + .4 && q.throttle < .85) limited.speedTarget += elapsed;
        const p = q.brake > .03 ? 'brake' : q.throttle > .1 ? 'throttle' : 'coast';
        if (p !== 'coast' && pedal !== 'coast' && p !== pedal && lastSample?.corner) pedalSwitches++;
        if (p !== 'coast') pedal = p;
        const td = lastSample ? q.throttle - lastSample.throttle : 0, bd = lastSample ? q.brake - lastSample.brake : 0;
        if (Math.abs(td) > .035) {
          if (throttleDirection && Math.sign(td) !== throttleDirection && q.time - throttleAt < .5 && lastSample?.corner) throttlePulses++;
          throttleDirection = Math.sign(td); throttleAt = q.time;
        }
        if (Math.abs(bd) > .035) {
          if (brakeDirection && Math.sign(bd) !== brakeDirection && q.time - brakeAt < .5 && lastSample?.corner) brakePulses++;
          brakeDirection = Math.sign(bd); brakeAt = q.time;
        }
      } else { pedal = 'coast'; throttleDirection = brakeDirection = 0; }
      const bin = Math.floor(car.s / 500), b = bins.get(bin) ?? { seconds: 0, v: 0, throttle: 0, brake: 0, pulses: 0 };
      b.seconds += elapsed; b.v += q.v * elapsed; b.throttle += q.throttle * elapsed; b.brake += q.brake * elapsed;
      if (lastSample && q.corner && lastSample.corner && q.throttle > .1 && lastSample.brake > .03) b.pulses++;
      bins.set(bin, b); maxError = Math.max(maxError, Math.abs(d.e ?? 0));
      lastSample = q; lastPath = d.path;
    };
    return base;
  } });
race.start();
if (!raceMode) for (const e of race.entries) { race.fitTyres(e.car, compound, process.argv.includes('--warm')); e.strategist.decide = () => null; }
const car = race.cars[0], started = performance.now(); let lap = car.race.lap;
const startTyres = car.wheels[0].tyre.compound;
while (rows.length < laps && race.phase !== 'finished' && race.time < duration) {
  race.step(FIXED_DT);
  if (race.time > 3 && !race.entries[0].pit && Math.abs(car.lateral) > track.halfWidth + track.curbWidth) {
    offSeconds += FIXED_DT;
    const bin = Math.floor(car.s / 100), b = offLocations.get(bin) ?? { seconds: 0, excess: 0 };
    b.seconds += FIXED_DT; b.excess = Math.max(b.excess, Math.abs(car.lateral) - track.halfWidth - track.curbWidth);
    offLocations.set(bin, b);
  }
  if (car.race.lap === lap) continue;
  rows.push({ lap, time: round(car.race.lastLap), state: car.race.lastState, wear: round(maxWear(car)),
    wheels: car.wheels.map(w => ({ core: round(w.tyre.core), wear: round(w.tyre.wear) })), damage: round(car.damage),
    compound: car.wheels[0].tyre.compound, stops: race.entries[0].strategist.stops,
    budget: race.entries[0].bridges[race.entries[0].active].driver?.stintBudget?.report });
  console.error(`${id} ${classId} ${trackId} ${compound} lap ${lap}: ${car.race.lastLap.toFixed(3)}s`);
  lap = car.race.lap; if (!raceMode) car.fuel = TANK_LITRES;
}
console.log(JSON.stringify({ id, classId, trackId, compound, hz, options, nativeHeldCadence: true, calLaps,
  seconds: round(race.time), wall: round((performance.now() - started) / 1000), rows,
  startTyres, phase: race.phase, finish: car.race.finishTime, stops: race.entries[0].strategist.stops,
  completed: car.race.lap > calLaps && !race.entries[0].retired,
  lapsCompleted: car.race.lap - 1, retired: Boolean(race.entries[0].retired),
  swaps: race.entries[0].strategist.swaps, decisions: race.entries[0].strategist.decisions?.slice(-6),
  corner: { seconds: round(cornerSeconds), meanThrottle: round(throttleSum / cornerSeconds), meanBrake: round(brakeSum / cornerSeconds),
    throttlePulses, brakePulses, pedalSwitches, limited: Object.fromEntries(Object.entries(limited).map(([k,v]) => [k, round(v)])) },
  targetJumps, pathSwitches, jumps, maxError: round(maxError), offSeconds: round(offSeconds), contacts: race.contacts,
  severe: race.collisionStats.severeContacts, errors: race.entries.map(e => e.bridges.map(b => b.errors ?? 0)),
  incidents: race.stewards.of(race.entries[0]).log.map(row => row.kind),
  offLocations: [...offLocations].sort((a,b) => b[1].seconds - a[1].seconds).slice(0,4).map(([bin,b]) => ({ from: bin * 100, seconds: round(b.seconds), excess: round(b.excess) })),
  lastError: race.entries[0].bridges[0].lastError ?? null,
  pulseSectors: [...bins].sort((a,b) => b[1].pulses - a[1].pulses).slice(0,5).map(([bin,b]) => ({ from: bin * 500,
    seconds: round(b.seconds), speed: round(b.v / b.seconds * 3.6), throttle: round(b.throttle / b.seconds), brake: round(b.brake / b.seconds), switches: b.pulses })) }));
