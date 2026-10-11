import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { observe, SCHEMA, toControls } from '../src/schema.mjs';
import { ActionMailbox, supervise } from '../src/runtime.mjs';
import { runScenario } from './scenario.mjs';
const checks = [];
const test = async (name, fn) => { await fn(); checks.push(name); };
const team = i => ({ id: 'check' + i, index: i, starter: 0, grid: i, classId: i ? 'gt' : 'lmdh',
  drivers: [{ kind: 'ai', id: 'intercept', name: 'INTERCEPT' }] });
const race = new EnduranceRace({ track: new Track('harbor-ring'), teams: [team(0), team(1)], laps: 20,
  format: { ...FORMATS.custom, mandatoryStops: 0 }, makeBridge: () => ({ update() {}, reset() {} }) });
const [car, other] = race.cars;
car.place(race.track, 20, 0, 55); other.place(race.track, 80, 0, 40);
await test('finite bounded sensors and correct size', () => {
  const r = observe(race, car); assert.equal(r.raw.length, SCHEMA.size); assert.deepEqual(r.missing, []);
  assert(r.normalized.every(Number.isFinite)); assert(r.normalized.every((x, i) => x >= SCHEMA.fields[i].min && x <= SCHEMA.fields[i].max));
});
await test('encoder does not mutate vehicles or track surfaces', () => {
  const surfaceState = () => JSON.stringify(Object.fromEntries(Object.keys(race.track).filter(k => /rubber|water|wet|grid|temperature|ambient|nodes/i.test(k)).map(k => [k, race.track[k]])),
    (key, value) => key === 'track' && value === race.track ? undefined : value);
  const state = JSON.stringify(race.cars), surfaces = surfaceState();
  for (let i = 0; i < 10; i++) observe(race, car);
  assert.equal(JSON.stringify(race.cars), state); assert.equal(surfaceState(), surfaces);
});
await test('other class remains visible', () => assert(observe(race, car).selected.some(x => x.id === other.id)));
await test('pit service car excluded', () => {
  race.entries[1].pit = { phase: 'service' }; const r = observe(race, car);
  assert(!r.selected.some(x => x.id === other.id)); assert(r.rejected.some(x => x.reason === 'pit')); race.entries[1].pit = null;
});
await test('pit approach explicit, never silently a racing target', () => {
  race.entries[1].pitPlan = { tyres: 'medium' }; assert(observe(race, car).selected[0].pitApproach); race.entries[1].pitPlan = null;
});
await test('retired car excluded', () => {
  race.entries[1].retired = true; assert.equal(observe(race, car).selected.length, 0); race.entries[1].retired = false;
});
await test('nearby off-road stopped hazard stays visible', () => {
  other.place(race.track, 45, race.track.halfWidth + 1, 0); const r = observe(race, car);
  assert(r.selected[0].offRoad); other.place(race.track, 80, 0, 40);
});
await test('empty opponent slots really masked to zero', () => {
  race.entries[1].retired = true; assert(observe(race, car).normalized.slice(SCHEMA.groups.rivals.offset).every(x => x === 0)); race.entries[1].retired = false;
});
await test('front hazard limits throttle without choosing a line', () => {
  other.place(race.track, 30, 0, 0); const r = supervise([.13, 1], race, car);
  assert(r.controls.brake > 0); assert.equal(r.controls.steer, .13); assert.equal(r.controls.throttle, 0);
});
await test('separated alongside rubbing is not a front obstruction', () => {
  other.place(race.track, 20, 1.8, 54); const r = supervise([0, 1], race, car);
  assert.deepEqual(r.reasons, []); assert.equal(r.controls.throttle, 1);
});
await test('fresh safety follows the actual ghost collision rule', () => {
  other.place(race.track, 30, 0, 0); other.ghost = true;
  assert(supervise([0, 1], race, car).controls.brake > 0);
  car.ghost = true; assert.equal(supervise([0, 1], race, car).controls.brake, 0);
  car.ghost = false; other.ghost = false;
});
await test('thin matched-speed corner rub is permitted, full nose obstruction is not', () => {
  const position = side => { other.x = car.x + Math.sin(car.yaw) * 3 + Math.cos(car.yaw) * side;
    other.z = car.z + Math.cos(car.yaw) * 3 - Math.sin(car.yaw) * side; other.yaw = car.yaw;
    other.vx = Math.sin(car.yaw) * 52; other.vz = Math.cos(car.yaw) * 52; };
  position(1.8); assert.equal(supervise([0, 1], race, car).controls.throttle, 1);
  position(0); assert(supervise([0, 1], race, car).controls.brake > 0);
});
await test('finite emergency control on invalid policy', () => assert.deepEqual(supervise([NaN, 1], race, car).reasons, ['non-finite']));
await test('signed pedals are exclusive and clamped', () => {
  assert.deepEqual(toControls([3, -2]), { steer: 1, throttle: 0, brake: 1 });
});
await test('late reply cannot advance hidden state', () => {
  const m = new ActionMailbox(), request = m.request(1); assert(!m.accept({ ...request, action: [0, 1], hidden: new Array(128).fill(1) }, 1.25));
  assert(m.hidden.every(x => x === 0)); assert.equal(m.accepted, 0); assert.equal(m.stats.late, 1);
});
await test('older reply cannot overwrite a newer accepted command', () => {
  const m = new ActionMailbox(), a = m.request(0), b = m.request(.01);
  assert(m.accept({ ...b, action: [.2, 1], hidden: new Array(128).fill(.1) }, .02));
  assert(!m.accept({ ...a, action: [-1, -1], hidden: new Array(128).fill(9) }, .03)); assert.deepEqual(m.action, [.2, 1]);
});
await test('reset invalidates previous-seat replies', () => {
  const m = new ActionMailbox(), r = m.request(0); m.reset(); assert(!m.accept({ ...r, action: [0, 1], hidden: new Array(128).fill(1) }, .01));
});
await test('real simulator repeatable; requested/executed/post states aligned', async () => {
  const a = await runScenario({ seconds: 3 }), b = await runScenario({ seconds: 3 });
  assert.equal(a.summary.progress, b.summary.progress); assert.deepEqual(a.events, b.events);
  assert.equal(a.summary.rows, 180); assert.equal(a.summary.missingRows, 0); assert(a.summary.minFuel > 50);
  for (let i = 0; i < a.rows.length; i++) {
    const r = a.rows[i]; assert(r.post && r.before); assert.equal(r.substeps.length, 2);
    assert.equal(r.progressDelta, r.post.progress - r.before.progress);
    assert.deepEqual(r.executed, r.substeps[0].controls);
    if (i) assert.equal(r.before.progress, a.rows[i - 1].post.progress);
    assert.deepEqual(r.observation.normalized, b.rows[i].observation.normalized);
  }
});
await test('20 Hz held controls recorded with six physical substeps', async () => {
  const r = await runScenario({ seconds: 1, rate: 20 }); assert.equal(r.summary.rows, 20); assert(r.rows.every(x => x.substeps.length === 6));
});
await test('rain observations finite and surfaces refreshed from actual race', async () => {
  const r = await runScenario({ seconds: 1, weather: 'rain' }); assert.equal(r.summary.missingRows, 0); assert(r.rows.every(x => x.observation.normalized.every(Number.isFinite)));
});
await test('250/500 ms reply spikes are rejected under actual physics stepping', async () => {
  for (const spikeMs of [250, 500]) {
    const r = await runScenario({ seconds: 1, mode: 'policy', spikeAt: .2, spikeMs,
      policy: async (_x, h) => ({ action: [0, .5], hidden: h.map(x => x + .001) }) });
    assert(r.summary.mailbox.obsolete + r.summary.mailbox.late > 0);
    assert(r.rows.some(x => x.acceptedSequence > 10)); assert(r.rows.every(x => Number.isFinite(x.post.speed)));
  }
});
await test('all supported circuits/class combinations provide valid physical observations', async () => {
  for (const track of ['harbor-ring', 'solenne', 'alpine', 'desert', 'nurburgring']) for (const classId of ['gt', 'lmdh']) {
    const r = await runScenario({ seconds: .1, track, classId }); assert.equal(r.summary.missingRows, 0);
  }
});
await test('stopped obstacle clearance is not race-pass credit', async () => {
  const r = await runScenario({ fixture: 'stopped', seconds: 8 });
  assert.equal(r.summary.retainedPasses, 0); assert(r.summary.encounters.every(e => e.kind === 'hazard'));
});
await test('500 ms inference blackout preserves fresh safety and records elapsed decision time', async () => {
  const r = await runScenario({ fixture: 'stopped', hazardAt: .3, rivalOffset: 2.5, seconds: 1, mode: 'policy', stallAt: .2, stallMs: 500,
    policy: async (_x, h) => ({ action: [0, 1], hidden: h }) });
  const held = r.rows.filter(x => x.inferenceStalled); assert(held.length >= 28);
  assert(held.some(x => x.safety.some(s => s.startsWith('front-blocked'))));
  assert(r.rows.some(x => !x.inferenceStalled && x.decisionDt > .5)); assert.equal(r.summary.contacts, 0);
});
await test('expert collection is explicitly training-only; policy evaluation cannot use it', async () => {
  const policy = async (_x, h) => ({ action: [0, .5], hidden: h });
  const mixed = await runScenario({ seconds: 1, mode: 'dagger', expertMix: 1, policy });
  const teacher = await runScenario({ seconds: 1 });
  assert.equal(mixed.summary.expertRows, 60); assert(mixed.rows.every(r => r.actionSource === 'training-expert'));
  assert.equal(mixed.summary.progress, teacher.summary.progress); assert(mixed.summary.scope.includes('Training only'));
  const actor = await runScenario({ seconds: 1, mode: 'policy', expertMix: 1, policy });
  assert.equal(actor.summary.expertRows, 0); assert(actor.rows.every(r => r.actionSource === 'pulse-policy'));
});
await test('recurrent elapsed time follows accepted state across delayed overlapping requests', async () => {
  const r = await runScenario({ seconds: 1, mode: 'policy', lagMs: 40,
    policy: async (_x, h) => ({ action: [0, .5], hidden: h.map(v => v + .001) }) });
  assert(r.summary.mailbox.obsolete > 0);
  assert(r.rows.some(row => row.recurrentDt >= .05));
  for (const row of r.rows) assert(Math.abs(row.observation.raw[14] - Math.max(row.dt, row.actionAge)) < 1e-9);
});
await test('legal kerb use is distinct from asphalt-edge crossing', async () => {
  const r = await runScenario({ seconds: .05, start: 500, lateral: 8.2, speed: 0 });
  assert(r.summary.asphaltEdgeSeconds > 0); assert.equal(r.summary.trackLimitSeconds, 0);
  assert.equal(r.summary.gameOfftrack, 0);
});
await test('mid-lap starts never create a false full-lap pace record', async () => {
  const r = await runScenario({ seconds: 110, start: 1000 });
  const laps = r.events.filter(e => e.type === 'lap');
  assert(laps.length >= 2); assert.equal(laps[0].full, false); assert(laps.slice(1).every(l => l.full));
  assert(r.summary.fullLaps.length >= 1); assert(r.summary.bestFullLap > 45);
  assert(laps[0].seconds < r.summary.bestFullLap);
});
for (const entry of race.entries) for (const bridge of entry.bridges) bridge.dispose?.();
console.log(JSON.stringify({ passed: checks.length, checks }));
