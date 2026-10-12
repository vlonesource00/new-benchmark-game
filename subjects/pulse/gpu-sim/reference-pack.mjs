// Multi-car parity reference: packs of 2..N cars on one track, stepped in the
// race tick order (wakes from pre-tick positions, each car's physics, then the
// engine's pairwise collisions). Drivers differ in pace and some steer into a
// rival's line, so the record is dense with slipstream, rubbing and impacts.
//   node --import ../../../scripts/json-loader.mjs gpu-sim/reference-pack.mjs --out <dir> --cases 100 --slots 6 --seconds 10 --seed 1
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Vehicle, wakes, collisions } from '../../../game/engine/sim/vehicle.js';
import { Track } from '../../../game/engine/sim/track.js';
import { clamp, angle, random } from '../../../game/engine/sim/math.js';
import { CAR_FIELDS, WHEEL_FIELDS, TYRE_FIELDS } from './reference-fields.mjs';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const out = resolve(arg('out')), cases = +arg('cases', 100), slots = +arg('slots', 6), seconds = +arg('seconds', 10), seed = +arg('seed', 1);
const rubberOn = arg('rubber', 'on') !== 'off', trackId = arg('track', 'harbor-ring'), DT = 1 / 120, steps = Math.round(seconds / DT);
if (existsSync(out)) throw Error('Preserve reference ' + out);
mkdirSync(out, { recursive: true });
const INPUTS = ['throttle', 'brake', 'steer', 'hybridForce'];
const fields = [...CAR_FIELDS, ...[0, 1, 2, 3].flatMap(w => [...WHEEL_FIELDS.map(f => `w${w}.${f}`), ...TYRE_FIELDS.map(f => `w${w}.tyre.${f}`)])];
const read = car => [...CAR_FIELDS.map(f => car[f]), ...car.wheels.flatMap(w => [...WHEEL_FIELDS.map(f => w[f]), ...TYRE_FIELDS.map(f => w.tyre[f])])];
const F = fields.length, rand = random(seed), uniform = (a, b) => a + (b - a) * rand();
const states = new Float64Array(cases * (steps + 1) * slots * F), inputs = new Float64Array(cases * steps * slots * INPUTS.length);
const wakeOut = new Float64Array(cases * steps * slots), contacts = new Float64Array(cases * steps);
const track0 = new Track(trackId);
const meta = { format: 'pulse-gpu-parity-pack-v1', track: trackId, dt: DT, steps, seconds, seed, slots, rubber: rubberOn, fields, inputs: INPUTS,
  trackGeometry: { length: track0.length, halfWidth: track0.halfWidth, curbWidth: track0.curbWidth, runoffWidth: track0.runoffWidth,
    barrierOffset: track0.barrierOffset, laneWidth: track0.laneWidth, nodes: track0.nodes.map(n => [n.x, n.z, n.s, n.tx, n.tz, n.curvature]) },
  cases: [] };

for (let k = 0; k < cases; k++) {
  const track = new Track(trackId);
  track.tempGrip = uniform(.955, 1); track.ambient = uniform(12, 34);
  // Diagnostic only (--rubber off): no rubber is laid, isolating the in-tick car order.
  if (!rubberOn) track.deposit = () => 0;
  const count = 2 + Math.floor(rand() * (slots - 1)), s0 = uniform(0, track.length), cars = [], drivers = [];
  for (let j = 0; j < count; j++) {
    const classId = rand() < .5 ? 'gt' : 'lmdh', car = new Vehicle(j, 'P' + j, '#fff', classId);
    car.place(track, s0 + uniform(-35, 35), uniform(-4.5, 4.5), uniform(25, 55));
    car.yaw += uniform(-.03, .03);
    cars.push(car);
    // Pace (grip budget) differs per car; a 'bully' steers onto the line of the car nearest ahead.
    drivers.push({ grip: uniform(16, 36), target: uniform(-4, 4), bully: rand() < .4, hybrid: classId === 'lmdh' && rand() < .5 ? uniform(0, 3500) : 0, noise: 0 });
  }
  meta.cases.push({ count, classIds: cars.map(c => c.classId), tempGrip: track.tempGrip, ambient: track.ambient });
  const put = (t, j, car) => states.set(read(car), ((k * (steps + 1) + t) * slots + j) * F);
  cars.forEach((c, j) => put(0, j, c));
  for (let t = 0; t < steps; t++) {
    cars.forEach((car, j) => {
      const d = drivers[j];
      if (rand() < 1 / 240) d.target = uniform(-5, 5);
      d.noise = d.noise * .97 + (rand() - .5) * .04;
      const p = track.nearest(car.x, car.z);
      let target = d.target;
      if (d.bully) {
        let best = Infinity;
        for (const o of cars) if (o !== car) { const ahead = ((track.nearest(o.x, o.z).s - p.s) % track.length + track.length) % track.length; if (ahead < 40 && ahead < best) { best = ahead; target = o.lateral; } }
      }
      const look = track.at(p.s + 8 + car.speed * .55, target), heading = Math.atan2(look.x - car.x, look.z - car.z);
      const steer = clamp(angle(heading - car.yaw) * 2.4 + d.noise, -1, 1);
      let ahead = 0;
      for (let s = 10; s <= 120; s += 10) ahead = Math.max(ahead, Math.abs(track.at(p.s + s).curvature));
      const vTarget = Math.min(85, Math.sqrt(d.grip / Math.max(ahead, 1e-4)));
      const throttle = clamp((vTarget - car.speed) * .25, 0, 1), brake = clamp((car.speed - vTarget) * .12, 0, 1);
      car.controls = { throttle, brake, steer };
      car.hybridForce = d.hybrid * throttle;
      inputs.set([throttle, brake, steer, car.hybridForce], ((k * steps + t) * slots + j) * INPUTS.length);
    });
    const airflow = wakes(cars);
    wakeOut.set(airflow, (k * steps + t) * slots);
    cars.forEach((c, i) => c.step(DT, track, airflow[i]));
    contacts[k * steps + t] = collisions(cars);
    cars.forEach((c, j) => put(t + 1, j, c));
  }
}
writeFileSync(resolve(out, 'meta.json'), JSON.stringify(meta));
for (const [name, data] of [['states', states], ['inputs', inputs], ['wakes', wakeOut], ['contacts', contacts]])
  writeFileSync(resolve(out, name + '.f64'), Buffer.from(data.buffer));
console.log(JSON.stringify({ cases, slots, steps, cars: meta.cases.reduce((n, c) => n + c.count, 0), contacts: contacts.reduce((a, b) => a + b, 0) }));
