// TEMPEST regression checks: perception semantics, the native bridge, and whole races through the systems the
// controller has to live with (pit stops, driver swaps, SC/FCY, rain, changing weather).
//   node --import ./scripts/json-loader.mjs subjects/tempest/tools/check.mjs
import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { PitLane } from '../../../game/core/pit.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createTempestBridge } from '../../../game/bridges/tempest-bridge.js';
import { Perception } from '../src/perception.js';

const track = new Track('harbor-ring'), lane = new PitLane(track, 2);
const me = new Vehicle(0, 'me', '#fff', 'lmdh'), other = new Vehicle(1, 'other', '#fff', 'lmdh');
me.id = 0; other.id = 1; me.place(track, 300, 0, 55); other.place(track, 330, 0, 45);
const seen = new Perception(track);
const observe = (meta = {}) => { seen.reset(); seen.update(me, [me, other], {}, 0, { rivals: [{ id: 1, ...meta }] }); return seen.list; };
let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS ' + name); }

test('ordinary same-class opponent is a target', () => assert.equal(observe()[0].target, true));
test('box call keeps the body solid but is not a target', () => { const r = observe({ boxCalled: true })[0]; assert.ok(r); assert.equal(r.box, true); assert.equal(r.target, false); });
test('pit approach is a road obstacle, never a target', () => { const r = observe({ pit: 'approach' })[0]; assert.ok(r); assert.equal(r.target, false); });
for (const phase of ['lane', 'service']) test('pit ' + phase + ' is excluded from road traffic', () => {
  other.place(track, lane.boxes[1], phase === 'service' ? lane.boxLat : lane.laneLat, 10);
  assert.equal(observe({ pit: phase }).length, 0);
});
test('retired car on the road stays a hazard', () => {
  other.place(track, 330, 0, 0); const r = observe({ retired: true })[0]; assert.ok(r); assert.equal(r.hazard, true); assert.equal(r.target, false);
});
test('other-class car is traffic, not a target', () => {
  const gt = new Vehicle(1, 'gt', '#fff', 'gt'); gt.place(track, 330, 0, 45);
  seen.reset(); seen.update(me, [me, gt], {}, 0, { rivals: [] }); assert.equal(seen.list[0].target, false);
});
test('native bridge gives finite controls without errors', () => {
  other.place(track, 330, 0, 45);
  const b = createTempestBridge({ hostTrack: track }); b.reset({ cars: [me, other] });
  for (let i = 0; i < 30; i++) b.update(me, [me, other], 1 / 60, { time: i / 60 });
  assert.equal(b.errors, 0, b.lastError);
  for (const key of ['steer', 'brake', 'throttle']) assert.ok(Number.isFinite(me.controls[key]));
});

// Whole races: every car TEMPEST, two drivers per car.
function race({ laps, cars = 3, weather = 'clear', caution = 'off', format = {}, tyre = null, at = null, cap = 160 * laps + 120 }) {
  const teams = Array.from({ length: cars }, (_, i) => ({ id: 't' + i, name: 'TMP' + i, short: 'TM' + i, color: '#fff', index: i, starter: 0, classId: 'lmdh', raceClass: 'gtp', grid: i,
    drivers: [{ kind: 'ai', id: 'tempest', name: 'tempest', short: 'TMP' }, { kind: 'ai', id: 'tempest', name: 'tempest', short: 'TMP' }] }));
  const r = new EnduranceRace({ track: new Track('harbor-ring'), teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false, ...format }, laps,
    startCompound: 'hard', startType: 'rolling', seed: 7, weatherSeed: 7, weather, caution });
  r.start();
  if (tyre) for (const c of r.cars) r.fitTyres(c, tyre, true);
  let called = false, sawCaution = false;
  while (r.phase !== 'finished' && r.time < cap) {
    r.step(FIXED_DT);
    if (at && !called && !r.formation && r.time > at.time) { r.callCaution(at.kind); called = true; }
    sawCaution ||= Boolean(r.caution?.active);
  }
  const errors = r.entries.flatMap((e) => e.bridges.map((b) => b.errors ?? 0)).reduce((a, b) => a + b, 0);
  const lastError = r.entries.flatMap((e) => e.bridges.map((b) => b.lastError)).find(Boolean);
  const stewards = r.entries.map((e) => r.stewards.of(e));
  return { r, errors, lastError, sawCaution, stewards, severe: r.collisionStats.severeContacts };
}
const common = (x) => {
  assert.equal(x.r.phase, 'finished', 'race finished');
  assert.equal(x.errors, 0, x.lastError);
  assert.equal(x.severe, 0, 'severe contacts');
  assert.ok(x.stewards.every((s) => !s.dq), 'no disqualification');
  for (const c of x.r.cars) assert.ok(Number.isFinite(c.race.bestLap) && c.race.bestLap > 0, 'lap times');
};

test('pit stop and driver swap complete and the race finishes', () => {
  const x = race({ laps: 5, format: { mandatoryStops: 1, mandatorySwap: true } });
  common(x);
  for (const e of x.r.entries) { assert.ok(e.strategist.stops >= 1, 'stop made'); assert.ok(e.strategist.swaps >= 1, 'driver swapped'); assert.ok(e.stints.length >= 2, 'second stint'); }
});
for (const kind of ['sc', 'fcy']) test(kind.toUpperCase() + ' period runs clean and back to green', () => {
  const x = race({ laps: 4, caution: kind === 'sc' ? 'full' : 'fcy', at: { time: 70, kind } });
  common(x); assert.ok(x.sawCaution, 'caution was active');
  assert.equal(x.stewards.reduce((a, s) => a + s.issued, 0), 0, 'no caution penalties');
});
test('rain on wet tyres: clean laps, low damage', () => {
  const x = race({ laps: 2, weather: 'rain', tyre: 'wet' });
  common(x); for (const c of x.r.cars) assert.ok(c.damage < 0.05, 'damage ' + c.damage);
});
test('changeable weather with the strategist free to change tyres', () => {
  const x = race({ laps: 5, weather: 'changeable', format: { mandatoryStops: 1, mandatorySwap: false } });
  common(x);
});
console.log(`${n} checks passed`);
