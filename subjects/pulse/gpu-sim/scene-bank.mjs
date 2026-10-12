// Scene bank for the GPU training env: the exact state of every car as the real
// scenario harness's main loop begins (after the standing start, placement, warm
// tyres and standing hazards), plus rubber, hybrid, steward and timing context,
// for each generated-field case of a split. Also bakes the executor class
// constants (line, options, GGV) so the env needs nothing else from JS.
//   node --import ../../../scripts/json-loader.mjs gpu-sim/scene-bank.mjs --suite <plan.json> --split train --out <dir>
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { Track } from '../../../game/engine/sim/track.js';
import { carSpecFor } from '../../../game/engine/sim/car-specs.js';
import { runScenario } from '../tools/scenario.mjs';
import { PlanExecutor } from '../src/plan-executor.mjs';
import { SCHEMA } from '../src/schema-v2.mjs';
import { PLAN_CONTRACT } from '../src/plan-contract.mjs';
import GGV from '../../apex/data/ggv.json' with { type: 'json' };
import { CAR_FIELDS, WHEEL_FIELDS, TYRE_FIELDS } from './reference-fields.mjs';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const out = resolve(arg('out')), split = arg('split', 'train'), limit = +arg('limit', Infinity);
const suite = JSON.parse(readFileSync(resolve(arg('suite')), 'utf8'));
if (split === 'final-test') throw Error('The sealed final-test split never enters training scenes');
if (existsSync(out)) throw Error('Preserve scene bank ' + out);
const slots = 7;
const fields = [...CAR_FIELDS, ...[0, 1, 2, 3].flatMap(w => [...WHEEL_FIELDS.map(f => `w${w}.${f}`), ...TYRE_FIELDS.map(f => `w${w}.tyre.${f}`)])];
const read = car => [...CAR_FIELDS.map(f => car[f]), ...car.wheels.flatMap(w => [...WHEEL_FIELDS.map(f => w[f]), ...TYRE_FIELDS.map(f => w.tyre[f])])];
const F = fields.length;
const cases = suite.cases.filter(c => c.split === split).slice(0, limit);
const PLAN_EXECUTION = { roadBounds: 'line-kerb-v1', edgeRamp: 30, frontalGuard: 'live-body-speed-v1', routeOrigin: 'rolling-v1',
  feedback: 'course-v1', joinState: 'reference-v1' };
const trackId = cases[0].settings.track, track0 = new Track(trackId);
const classes = {};
for (const classId of ['lmdh', 'gt']) {
  const probe = new PlanExecutor(new Track(trackId), new Vehicle(0, 'P', '#fff', classId), PLAN_EXECUTION), line = probe.course.line, sp = carSpecFor(classId);
  classes[classId] = { N: line.N, ds: line.ds, options: probe.options, dragK: probe.course.model.dragK, ggv: GGV[classId],
    line: Object.fromEntries(['px', 'pz', 'len', 'h', 'k', 'ks', 'dk', 'lat', 'st'].map(k => [k, Array.from(line[k])])),
    mass: sp.mass, drive: sp.drive ?? 'rear', halfWidth: sp.halfWidth, halfLength: sp.halfLength, track: sp.track };
}
const meta = { format: 'pulse-gpu-scene-bank-v1', suite: suite.name, suiteDigest: suite.digest, split, slots, fields, planExecution: PLAN_EXECUTION,
  planContract: PLAN_CONTRACT, observation: { version: SCHEMA.version, fields: SCHEMA.fields, previewSeconds: SCHEMA.previewSeconds }, classes,
  trackGeometry: { id: trackId, length: track0.length, halfWidth: track0.halfWidth, curbWidth: track0.curbWidth, runoffWidth: track0.runoffWidth,
    barrierOffset: track0.barrierOffset, laneWidth: track0.laneWidth, nodes: track0.nodes.map(n => [n.x, n.z, n.s, n.tx, n.tz, n.curvature]) },
  scenes: [] };
const states = new Float64Array(cases.length * slots * F).fill(NaN), rubber = new Float32Array(cases.length * track0.nodes.length * 13);
class Captured extends Error {}

for (const [k, spec] of cases.entries()) {
  let scene = null;
  try {
    await runScenario({ ...spec.settings, mode: 'teacher', transport: 'native', rate: 60, observationVersion: SCHEMA.version,
      raceHook: race => {
        const track = race.track;
        for (const id of new Set(race.cars.map(car => car.classId))) classes[id].deployMap ??= Array.from(race.deployMapFor(race.cars.find(car => car.classId === id)));
        race.cars.forEach((car, j) => states.set(read(car), (k * slots + j) * F));
        rubber.set(track.rubber, k * track0.nodes.length * 13);
        scene = { id: spec.id, family: spec.family, profile: spec.profile, requirements: spec.requirements, seconds: spec.settings.seconds,
          timing: { frameSteps: spec.settings.frameSteps ?? 2, lagFrames: spec.settings.lagFrames ?? 0, lagJitter: spec.settings.lagJitter ?? 0,
            frameJitter: spec.settings.frameJitter ?? 0, scheduleSeed: spec.settings.scheduleSeed ?? 7 },
          count: race.cars.length, raceTime: race.time, tempGrip: track.tempGrip, ambient: track.ambient, trackTemperature: track.temperature,
          cars: race.cars.map((car, j) => {
            const e = race.entries[j], st = race.stewards.of(e), t = car.wheels[0].tyre, f = j ? spec.settings.field?.[j - 1] ?? null : null;
            return { classId: car.classId, driver: j ? f?.driver ?? spec.settings.rival : 'pulse', tyre: [t.gripScale, t.wearScale, t.optimum, t.heat, t.coldPressure],
              compound: t.compound, hybrid: car.hybrid ? { energy: car.hybrid.energy, mode: car.hybrid.mode } : null,
              laps: race.laps, lap: car.race.lap, stintLaps: e.strategist.stintLaps, nextTyreLap: e.strategist.nextTyreLap ?? null,
              steward: { moving: !!st.moving, off: !!st.off, spun: !!st.spun, clean: st.clean },
              hazard: f?.hazard ?? null, stopAt: f?.stopAt ?? null, lateral: f?.lateral ?? null, speed: f?.speed ?? null };
          }) };
        throw new Captured();
      } });
  } catch (e) { if (!(e instanceof Captured)) throw e; }
  if (!scene) throw Error('No capture for ' + spec.id);
  meta.scenes.push(scene);
  if (k % 50 === 0) console.log(k, spec.id, scene.count, 'cars');
}
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'meta.json'), JSON.stringify(meta));
writeFileSync(resolve(out, 'states.f64'), Buffer.from(states.buffer));
writeFileSync(resolve(out, 'rubber.f32'), Buffer.from(rubber.buffer));
console.log(JSON.stringify({ scenes: meta.scenes.length, families: Object.fromEntries([...new Set(meta.scenes.map(s => s.family))].map(f => [f, meta.scenes.filter(s => s.family === f).length])) }));
