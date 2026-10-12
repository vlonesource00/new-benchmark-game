// Parity reference for the GPU port of the PULSE driving stack (PlanExecutor:
// route compile, INTERCEPT Course/Observer/Controller/noseConstraint, APEX
// Line/CarModel). Slot 0 is driven by the executor with random held plans; up to
// three scripted rivals share the road, some stopping as hazards. Every tick
// stores all car states and the executor's own controls, so the port can be run
// with physics teacher-forced and its internal state free.
//   node --import ../../../scripts/json-loader.mjs gpu-sim/reference-executor.mjs --out <dir> --cases 40 --seconds 20 --seed 1
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Vehicle, wakes, collisions } from '../../../game/engine/sim/vehicle.js';
import { Track } from '../../../game/engine/sim/track.js';
import { createTyre } from '../../../game/engine/sim/tyre.js';
import { carSpecFor } from '../../../game/engine/sim/car-specs.js';
import { COMPOUNDS, TYRE_HEAT } from '../../../game/core/rules.js';
import { clamp, angle, random } from '../../../game/engine/sim/math.js';
import { PlanExecutor } from '../src/plan-executor.mjs';
import { toAction, toControls } from '../src/schema.mjs';
import { settingsFor } from '../../intercept/src/settings.js';
import GGV from '../../apex/data/ggv.json' with { type: 'json' };
import { CAR_FIELDS, WHEEL_FIELDS, TYRE_FIELDS } from './reference-fields.mjs';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const out = resolve(arg('out')), cases = +arg('cases', 40), seconds = +arg('seconds', 20), seed = +arg('seed', 1), slots = 4;
const trackId = arg('track', 'harbor-ring'), DT = 1 / 120, steps = Math.round(seconds / DT);
if (existsSync(out)) throw Error('Preserve reference ' + out);
mkdirSync(out, { recursive: true });
// c186-field-v4 plan execution.
const PLAN_EXECUTION = { roadBounds: 'line-kerb-v1', edgeRamp: 30, frontalGuard: 'live-body-speed-v1', routeOrigin: 'rolling-v1',
  feedback: 'course-v1', joinState: 'reference-v1' };
const fields = [...CAR_FIELDS, ...[0, 1, 2, 3].flatMap(w => [...WHEEL_FIELDS.map(f => `w${w}.${f}`), ...TYRE_FIELDS.map(f => `w${w}.tyre.${f}`)])];
const read = car => [...CAR_FIELDS.map(f => car[f]), ...car.wheels.flatMap(w => [...WHEEL_FIELDS.map(f => w[f]), ...TYRE_FIELDS.map(f => w.tyre[f])])];
const F = fields.length, rand = random(seed), uniform = (a, b) => a + (b - a) * rand();
const OUTPUTS = ['steer', 'throttle', 'brake', 'kc', 'acceleration', 'grip', 'compiles', 'path', 'cursor', 'noseCap'];
const states = new Float64Array(cases * (steps + 1) * slots * F), inputs = new Float64Array(cases * steps * slots * 4);
const outputs = new Float64Array(cases * steps * OUTPUTS.length), wakeOut = new Float64Array(cases * steps * slots);
const track0 = new Track(trackId);

// Executor constants per class: the baked course after Line.load (geometry + locate), resolved options, GGV.
const classes = {};
for (const classId of ['lmdh', 'gt']) {
  const probe = new PlanExecutor(new Track(trackId), new Vehicle(0, 'P', '#fff', classId), PLAN_EXECUTION), line = probe.course.line;
  const sp = carSpecFor(classId);
  classes[classId] = { N: line.N, ds: line.ds, options: probe.options, dragK: probe.course.model.dragK, ggv: GGV[classId],
    line: Object.fromEntries(['px', 'pz', 'len', 'h', 'k', 'ks', 'dk', 'lat', 'st'].map(k => [k, Array.from(line[k])])),
    mass: sp.mass, drive: sp.drive ?? 'rear' };
}
const meta = { format: 'pulse-gpu-parity-executor-v1', track: trackId, dt: DT, steps, seconds, seed, slots, fields, outputs: OUTPUTS,
  planExecution: PLAN_EXECUTION, classes,
  trackGeometry: { length: track0.length, halfWidth: track0.halfWidth, curbWidth: track0.curbWidth, runoffWidth: track0.runoffWidth,
    barrierOffset: track0.barrierOffset, laneWidth: track0.laneWidth, nodes: track0.nodes.map(n => [n.x, n.z, n.s, n.tx, n.tz, n.curvature]) },
  cases: [] };

const fitTyres = (car, compound, wearScale, warm) => {
  const c = COMPOUNDS[compound], heat = c.heat * TYRE_HEAT[car.classId];
  for (const w of car.wheels) w.tyre = createTyre(car.setup.pressure, { compound, gripScale: c.grip, wearScale, optimum: c.optimum, heat, warm });
  return [c.grip, wearScale, c.optimum, heat, car.setup.pressure];
};

for (let k = 0; k < cases; k++) {
  const track = new Track(trackId);
  track.tempGrip = uniform(.955, 1); track.ambient = uniform(12, 34);
  const count = 1 + Math.floor(rand() * slots), s0 = uniform(0, track.length), cars = [], drivers = [], tyres = [];
  for (let j = 0; j < count; j++) {
    const classId = j === 0 ? (rand() < .8 ? 'lmdh' : 'gt') : rand() < .5 ? 'gt' : 'lmdh', car = new Vehicle(j, 'P' + j, '#fff', classId);
    if (j === 0) car.place(track, s0, uniform(-3, 3), uniform(30, 65));
    else car.place(track, s0 + uniform(15, 160), uniform(-4, 4), uniform(15, 50));
    car.yaw += uniform(-.02, .02);
    tyres.push(fitTyres(car, rand() < .7 ? 'soft' : 'medium', uniform(1.5, 8), rand() < .85));
    cars.push(car);
    // Rivals follow the road at their own pace; some stop dead (hazard) at a random time.
    drivers.push({ grip: uniform(14, 30), target: uniform(-4, 4), noise: 0, stopAt: j && rand() < .35 ? uniform(1, seconds * .6) : Infinity });
  }
  const executor = new PlanExecutor(track, cars[0], PLAN_EXECUTION);
  // Random held plans: three lateral knots and a pace cap, committed at a varying cadence.
  const plans = []; let nextPlan = 0, sequence = 0, plan = [0, 0, 0, 0];
  meta.cases.push({ count, classIds: cars.map(c => c.classId), tyres, tempGrip: track.tempGrip, ambient: track.ambient,
    stopAt: drivers.map(d => Number.isFinite(d.stopAt) ? d.stopAt : null), plans });
  const put = (t, j, car) => states.set(read(car), ((k * (steps + 1) + t) * slots + j) * F);
  cars.forEach((c, j) => put(0, j, c));
  for (let t = 0; t < steps; t++) {
    const time = t * DT;
    if (t >= nextPlan) {
      const smooth = rand() < .5, centre = uniform(-.8, .8);
      plan = [0, 1, 2].map(() => clamp(smooth ? centre + uniform(-.15, .15) : uniform(-1, 1), -1, 1)).concat(rand() < .5 ? 0 : uniform(-1, 0));
      if (rand() < .15) plan = [0, 0, 0, plan[3]];
      sequence++; plans.push({ tick: t, sequence, action: plan });
      nextPlan = t + Math.round(uniform(12, 72));
    }
    executor.commit(plan, sequence, time);
    const raw = executor.step(cars[0], cars, DT, { time }), c = executor.controller, tr = executor.trace;
    outputs.set([raw.steer, raw.throttle, raw.brake, c.kc, c.acceleration, executor.course.model.grip, executor.compiles,
      executor.path === executor.course.line ? -1 : executor.lanes.indexOf(executor.path), c.cursor, tr.noseCap ?? -1], (k * steps + t) * OUTPUTS.length);
    cars[0].controls = toControls(toAction(raw));
    cars.forEach((car, j) => {
      if (!j) return;
      const d = drivers[j];
      if (time >= d.stopAt) { car.controls = { throttle: 0, brake: 1, steer: 0 }; return; }
      if (rand() < 1 / 240) d.target = uniform(-5, 5);
      d.noise = d.noise * .97 + (rand() - .5) * .04;
      const p = track.nearest(car.x, car.z), look = track.at(p.s + 8 + car.speed * .55, d.target), heading = Math.atan2(look.x - car.x, look.z - car.z);
      let ahead = 0;
      for (let s = 10; s <= 120; s += 10) ahead = Math.max(ahead, Math.abs(track.at(p.s + s).curvature));
      const vTarget = Math.min(85, Math.sqrt(d.grip / Math.max(ahead, 1e-4)));
      car.controls = { throttle: clamp((vTarget - car.speed) * .25, 0, 1), brake: clamp((car.speed - vTarget) * .12, 0, 1),
        steer: clamp(angle(heading - car.yaw) * 2.4 + d.noise, -1, 1) };
    });
    cars.forEach((car, j) => { car.hybridForce = 0; inputs.set([car.controls.throttle, car.controls.brake, car.controls.steer, 0], ((k * steps + t) * slots + j) * 4); });
    const airflow = wakes(cars);
    wakeOut.set(airflow, (k * steps + t) * slots);
    cars.forEach((c, i) => c.step(DT, track, airflow[i]));
    collisions(cars);
    cars.forEach((c, j) => put(t + 1, j, c));
  }
  meta.cases.at(-1).compiles = executor.compiles;
}
writeFileSync(resolve(out, 'meta.json'), JSON.stringify(meta));
for (const [name, data] of [['states', states], ['inputs', inputs], ['outputs', outputs], ['wakes', wakeOut]])
  writeFileSync(resolve(out, name + '.f64'), Buffer.from(data.buffer));
console.log(JSON.stringify({ cases, steps, cars: meta.cases.reduce((n, c) => n + c.count, 0), compiles: meta.cases.reduce((n, c) => n + c.compiles, 0),
  damage: meta.cases.map((c, k) => +states[((k * (steps + 1) + steps) * slots) * F + fields.indexOf('damage')].toFixed(3)) }));
