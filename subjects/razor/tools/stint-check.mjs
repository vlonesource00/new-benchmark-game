import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { RazorStrategist } from '../src/strategy.js';
import { RazorStintModel, stintPriorsMatch } from '../src/stint-model.js';
import DATA from '../data/stints.json' with { type: 'json' };

let count = 0;
const test = (name, fn) => { fn(); count++; console.log('PASS ' + name); };
function fixture({ classId = 'lmdh', laps = 20, trackId = 'harbor-ring', weather = 'clear', ids = ['razor', 'razor'], stops } = {}) {
  const teams = [{ id: 'test', index: 0, name: 'test', short: 'RZR', color: '#fff', grid: 0, starter: 0,
    classId, raceClass: classId === 'lmdh' ? 'gtp' : 'gt3',
    drivers: ids.map(id => ({ id, name: id, short: id, kind: id === 'human' ? 'human' : 'ai' })) }];
  return new EnduranceRace({ track: new Track(trackId), teams, laps, weather, seed: 7,
    difficulty: 1, format: stops === undefined ? FORMATS.classic
      : { ...FORMATS.custom, mandatoryStops: stops, mandatorySwap: stops > 0 }, startType: 'rolling' });
}

test('priors reject missing or incompatible tyre metadata', () => {
  assert.equal(stintPriorsMatch(), true);
  for (const meta of [null, {}, { ...DATA.meta, baseline: {} }, { ...DATA.meta, classHeat: {} },
    { ...DATA.meta, wearCliff: DATA.meta.wearCliff + 0.01 },
    { ...DATA.meta, compounds: { ...DATA.meta.compounds, soft: [1, 1, 85, 1] } }]) {
    assert.equal(stintPriorsMatch(meta), false);
  }
});
for (const classId of ['lmdh', 'gt']) {
  const race = fixture({ classId }), strategy = race.entries[0].strategist;
  test(classId + ': native integration installs current RAZOR priors', () => {
    assert.ok(strategy instanceof RazorStrategist);
    assert.ok(strategy.model instanceof RazorStintModel);
    assert.equal(strategy.currentStints, true); assert.equal(strategy.usable, true);
  });
  test(classId + ': dead-tyre samples cannot imply unlimited tyre life', () => {
    const model = strategy.model;
    const worn = model.roll('soft', 12, { age0: 10, wear0: 0.9, core0: 90, warm: true });
    assert.ok(worn.wear[0] > 0.9); assert.equal(worn.wear.at(-1), 1);
    assert.ok(worn.t.some(t => t >= 1e9), 'Excess fade must be excluded from future stints');
  });
}
test('mixed human and AI teams retain the game planner', () => {
  for (const ids of [['human', 'razor'], ['razor', 'apex']]) {
    assert.ok(!(fixture({ ids }).entries[0].strategist instanceof RazorStrategist));
  }
});
test('unmeasured dry tracks and long races use the game planner', () => {
  const unknown = fixture({ trackId: 'alpine' }).entries[0].strategist;
  assert.equal(unknown.currentStints, true);
  assert.ok(unknown.model instanceof RazorStintModel);
  assert.equal(unknown.usable, false);
  assert.equal(new RazorStintModel('alpine', 'lmdh', unknown.cal).ok, false);
  assert.equal(fixture({ laps: 40 }).entries[0].strategist.usable, false);
});
for (const classId of ['lmdh', 'gt']) test(classId + ': four-lap dry Nurburgring starts on softs for each stop requirement', () => {
  for (const stops of [0, 1, 2]) {
    const race = fixture({ classId, laps: 4, trackId: 'nurburgring', stops });
    assert.equal(race.entries[0].strategist.usable, false, 'Old APEX tyre tables must not select the compound');
    assert.equal(race.cars[0].wheels[0].tyre.compound, 'soft');
  }
});
test('changeable weather keeps the existing policy and excludes the dry priors', () => {
  const strategy = fixture({ weather: 'changeable' }).entries[0].strategist;
  assert.equal(strategy.currentStints, false);
  assert.ok(!(strategy.model instanceof RazorStintModel));
});
console.log(JSON.stringify({ passed: count }));
