// Parity reference for the GPU race layer: runs the real scenario harness
// (tools/scenario.mjs, EnduranceRace) on generated-field cases with the teacher
// driving, and records every tick's car states, executed controls, hybrid force,
// energy and mode, wakes and ABS/TC flags, plus every decision's observation.
// The GPU env is checked against it with gpu-sim/parity_env.py.
//   node --import ../../../scripts/json-loader.mjs gpu-sim/reference-env.mjs --out <dir> --suite <plan.json> --cases 16 --seconds 15
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { carSpecFor } from '../../../game/engine/sim/car-specs.js';
import { runScenario } from '../tools/scenario.mjs';
import { SCHEMA } from '../src/schema-v2.mjs';
import { CAR_FIELDS, WHEEL_FIELDS, TYRE_FIELDS } from './reference-fields.mjs';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const out = resolve(arg('out')), count = +arg('cases', 16), seconds = +arg('seconds', 15), split = arg('split', 'train');
const suite = JSON.parse(readFileSync(resolve(arg('suite')), 'utf8'));
if (existsSync(out)) throw Error('Preserve reference ' + out);
const DT = 1 / 120, steps = Math.round(seconds / DT), slots = 7;
const fields = [...CAR_FIELDS, ...[0, 1, 2, 3].flatMap(w => [...WHEEL_FIELDS.map(f => `w${w}.${f}`), ...TYRE_FIELDS.map(f => `w${w}.tyre.${f}`)])];
const read = car => [...CAR_FIELDS.map(f => car[f]), ...car.wheels.flatMap(w => [...WHEEL_FIELDS.map(f => w[f]), ...TYRE_FIELDS.map(f => w.tyre[f])])];
const F = fields.length, O = SCHEMA.size;
// Spread the picks over families (hazard/traffic/race/solo) and timing profiles.
const pool = suite.cases.filter(c => c.split === split && c.settings.fixture === 'field');
const families = [...new Set(pool.map(c => c.family))].map(f => pool.filter(c => c.family === f));
const picks = Array.from({ length: count }, (_, k) => { const f = families[k % families.length]; return f[Math.floor(k / families.length) * 7 % f.length]; });

// Per tick and car: executed controls, hybrid force, wake, then ABS/TC, energy, deploy mode, ghost and the driver's
// energy intent (car.intent, NaN when none is valid) after the step.
const TICK = ['throttle', 'brake', 'steer', 'hybridForce', 'wake', 'abs', 'tc', 'energy', 'mode', 'ghost', 'intentDeploy', 'intentHarvest'], T = TICK.length;
const MODES = ['build', 'balanced', 'attack', 'qual'];
const states = new Float64Array(count * (steps + 1) * slots * F).fill(NaN), ticks = new Float64Array(count * steps * slots * T).fill(NaN);
const decisions = [];  // per case: [{ tick, raw }]
const meta = { format: 'pulse-gpu-parity-env-v1', suite: suite.name, dt: DT, steps, seconds, slots, fields, tick: TICK, modes: MODES,
  observation: { version: SCHEMA.version, fields: SCHEMA.fields }, classes: {}, cases: [] };
for (const id of ['lmdh', 'gt']) { const s = carSpecFor(id); meta.classes[id] = { halfWidth: s.halfWidth, halfLength: s.halfLength, track: s.track }; }

// Recording hooks. A placement (re)starts the case's log: the main loop begins after the last one.
let log = null;
const place = Vehicle.prototype.place, step = Vehicle.prototype.step;
Vehicle.prototype.place = function (...a) { const r = place.apply(this, a); if (log?.armed) log.rescued = true; return r; };
Vehicle.prototype.step = function (dt, track, wake = 0) {
  if (log?.armed && log.tick < steps) {
    const L = log, cars = L.race.cars, k = L.k;
    if (this === cars[0]) {
      cars.forEach((c, j) => states.set(read(c), ((k * (steps + 1) + L.tick) * slots + j) * F));
    }
    const j = cars.indexOf(this), at = ((k * steps + L.tick) * slots + j) * T;
    ticks.set([this.controls.throttle ?? 0, this.controls.brake ?? 0, this.controls.steer ?? 0, this.hybridForce ?? 0, wake], at);
    const r = step.call(this, dt, track, wake);
    ticks.set([+!!this.absActive, +!!this.tcActive, this.hybrid?.energy ?? 0, this.hybrid ? MODES.indexOf(this.hybrid.mode) : -1, +!!this.ghost,
      this.intent && this.intent.ttl > 0 ? this.intent.deploy : NaN, this.intent && this.intent.ttl > 0 ? this.intent.harvest ?? .5 : NaN], at + 5);
    if (this === cars.at(-1)) L.tick++;
    return r;
  }
  return step.call(this, dt, track, wake);
};

// Case constants as the main loop begins (before its first hybrid step): race clock, rubber, hybrid deploy maps, steward memory.
function capture(L) {
  const race = L.race, track = race.track, c = L.c;
  c.raceTime = race.time; c.rubber = Array.from(track.rubber);
  c.tempGrip = track.tempGrip; c.ambient = track.ambient; c.trackTemperature = track.temperature; c.wetness = track.wetness;
  c.cars = race.cars.map((car, j) => {
    const e = race.entries[j], st = race.stewards.of(e), t = car.wheels[0].tyre;
    return { classId: car.classId, fuel: car.fuel, tyre: [t.gripScale, t.wearScale, t.optimum, t.heat, t.coldPressure], compound: t.compound,
      hybrid: car.hybrid ? { energy: car.hybrid.energy, mode: car.hybrid.mode } : null, lap: car.race.lap, progress: car.race.progress,
      laps: race.laps, stintLaps: e.strategist.stintLaps, nextTyreLap: e.strategist.nextTyreLap ?? null,
      steward: { moving: !!st.moving, off: !!st.off, spun: !!st.spun, clean: st.clean, damage: st.damage, penalties: st.penalties.length } };
  });
  for (const id of new Set(race.cars.map(car => car.classId))) meta.classes[id].deployMap ??= Array.from(race.deployMapFor(race.cars.find(car => car.classId === id)));
  c.trackGeometry ??= { length: track.length, halfWidth: track.halfWidth, curbWidth: track.curbWidth, runoffWidth: track.runoffWidth,
    barrierOffset: track.barrierOffset, laneWidth: track.laneWidth, nodes: track.nodes.map(n => [n.x, n.z, n.s, n.tx, n.tz, n.curvature]) };
}

for (let k = 0; k < count; k++) {
  const spec = picks[k], c = { id: spec.id, family: spec.family, settings: spec.settings };
  const rows = [];
  log = { k, tick: 0, armed: false, rescued: false, start: null, c, race: null };
  // runScenario hands over its race as the main loop begins (raceHook); recording starts there.
  const result = await runScenario({ ...spec.settings, mode: 'teacher', transport: 'native', rate: 60, seconds,
    observationVersion: SCHEMA.version,
    onRow: row => rows.push({ tick: Math.round(row.time / DT), raw: row.observation.raw, selected: row.observation.selected.map(s => s.id) }),
    raceHook: race => { log.race = race; capture(log); log.armed = true; } });
  if (!log.race) throw Error('scenario.mjs did not expose its race (raceHook)');
  if (log.rescued) c.rescued = true;
  c.count = log.race.cars.length; c.ticks = log.tick; c.rows = rows.length;
  c.events = result.events.filter(e => ['contact', 'hazard-stop', 'retained-pass', 'hazard-cleared', 'lap'].includes(e.type));
  log.race.cars.forEach((car, j) => states.set(read(car), ((k * (steps + 1) + log.tick) * slots + j) * F));
  decisions.push(rows);
  meta.cases.push(c);
  console.log(k, spec.id, spec.profile, 'cars', c.count, 'ticks', log.tick, 'rows', rows.length, c.rescued ? 'RESCUED' : '');
}
meta.trackGeometry = meta.cases[0].trackGeometry; for (const c of meta.cases) delete c.trackGeometry;
meta.decisions = decisions.map(rows => rows.map(r => ({ tick: r.tick, selected: r.selected })));
mkdirSync(out, { recursive: true });
const obs = new Float64Array(decisions.reduce((n, r) => n + r.length, 0) * O); let at = 0;
for (const rows of decisions) for (const r of rows) { obs.set(r.raw, at); at += O; }
writeFileSync(resolve(out, 'meta.json'), JSON.stringify(meta));
for (const [name, data] of [['states', states], ['ticks', ticks], ['observations', obs]]) writeFileSync(resolve(out, name + '.f64'), Buffer.from(data.buffer));
