import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import { AI_DRIVERS, RACE_AI_DRIVERS } from '../../../game/core/teams.js';
import { createCounterpointBridge, createCounterpointExecutor } from '../../../game/bridges/counterpoint-bridge.js';
import { installWorkerShim } from '../../../scripts/bench/lockstep-workers.mjs';
import { plannerTelemetry } from './traffic-telemetry.mjs';

assert(AI_DRIVERS.some(d => d.id === 'counterpoint' && d.governor === false));
assert(!RACE_AI_DRIVERS.some(d => d.id === 'counterpoint'), 'unproven challenger is excluded from automatic fields');
assert.equal(plannerTelemetry({ planner: null, interactive: { decisions: 0 } }).interactive, null,
  'a missing worker reply cannot masquerade as an idle planner');
assert.equal(plannerTelemetry({ intent: 'ATTACK' }).intent, 'ATTACK', 'local driver debug remains usable');
const originalWorker = globalThis.Worker;
const shim = installWorkerShim({ frameSteps: 2, lagFrames: 1, seed: 101 });
for (const cls of ['gt', 'lmdh']) {
  const track = new Track('harbor-ring'), seats = new AsyncSeats('harbor-ring');
  const teams = ['counterpoint', 'intercept'].map((id, i) => ({ id: 'check' + i, index: i, grid: i, starter: 0,
    name: id, short: id.slice(0, 3), color: '#00f5d4', classId: cls, raceClass: cls === 'gt' ? 'gt3' : 'gtp',
    drivers: [{ id, name: id, kind: 'ai' }] }));
  const race = new EnduranceRace({ track, teams, laps: 3, seed: 101, weatherSeed: 101, weather: 'clear',
    startCompound: 'soft', startType: 'standing', difficulty: 1,
    format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, makeBridge: seats.factory() });
  try {
    const ready = seats.start(race); await shim.settle(); await ready;
    race.start(); seats.wantDebug = true;
    for (const e of race.entries) e.strategist.decide = () => null;
    for (let n = 0; n < 1200; n++) {
      race.step(FIXED_DT); shim.step();
      for (const car of race.cars) for (const key of ['throttle', 'brake', 'steer']) {
        assert(Number.isFinite(car.controls[key]), `${cls} async ${key} finite`);
      }
    }
    assert.equal(race.entries[0].bridges[0].errors, 0);
    assert.equal(race.entries[0].bridges[0].debug().architecture, 'COUNTERPOINT');
    const planner = plannerTelemetry(race.entries[0].bridges[0].debug());
    assert(planner.interactive && Number.isFinite(planner.interactive.decisions),
      `${cls} debug contains actual worker planner counters`);
    const bridge = createCounterpointBridge({ hostTrack: track });
    bridge.reset({ cars: race.cars });
    bridge.update(race.cars[0], race.cars, FIXED_DT, { time: race.time, state: { phase: 'racing' } });
    assert.equal(bridge.errors, 0);
    const executor = createCounterpointExecutor(track);
    executor.reset({ cars: race.cars });
    const preview = bridge.controlPreview();
    assert(preview);
    assert.equal(executor.adopt(preview, race.cars[0], 0), true);
    assert.equal(executor.adopt(preview, race.cars[0], 0), false, 'duplicate sequence rejected');
    assert.equal(executor.adopt({ ...preview, sequence: preview.sequence + 1, epoch: 2 }, race.cars[0], 0), false, 'stale epoch rejected');
    executor.update(race.cars[0], race.cars, FIXED_DT, { time: race.time, state: { phase: 'racing' } });
    assert.equal(executor.bridge.errors, 0);
    bridge.dispose();
    console.log(`${cls}: async delayed seat, own executor and preview epoch checks passed`);
  } finally { seats.dispose(); }
}
globalThis.Worker = originalWorker;
