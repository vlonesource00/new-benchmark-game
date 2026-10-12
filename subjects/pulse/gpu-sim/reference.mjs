// Parity reference for the batched GPU simulator: single-car physics recorded
// from the game's own Vehicle/Track at the race tick (1/120 s). Each case places
// a GT or LMDh car on the circuit and drives it with either a track-following
// driver (realistic racing) or a wild one (slides, run-off, barrier strikes).
// Every tick stores the full physical state, so the port can be checked one
// step at a time from the exact JS state as well as in free running.
//   node --import ../../../scripts/json-loader.mjs gpu-sim/reference.mjs --out <dir> --cases 300 --seconds 10 --seed 1
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { Track } from '../../../game/engine/sim/track.js';
import { clamp, angle, random } from '../../../game/engine/sim/math.js';
import { CAR_FIELDS, WHEEL_FIELDS, TYRE_FIELDS } from './reference-fields.mjs';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const out = resolve(arg('out')), cases = +arg('cases', 300), seconds = +arg('seconds', 10), seed = +arg('seed', 1);
const trackId = arg('track', 'harbor-ring'), DT = 1 / 120, steps = Math.round(seconds / DT);
if (existsSync(out)) throw Error('Preserve reference ' + out);
mkdirSync(out, { recursive: true });

const INPUT_FIELDS = ['throttle', 'brake', 'steer', 'wake', 'hybridForce'];
const fields = [...CAR_FIELDS, ...[0, 1, 2, 3].flatMap(w => [...WHEEL_FIELDS.map(f => `w${w}.${f}`), ...TYRE_FIELDS.map(f => `w${w}.tyre.${f}`)])];
const read = car => [...CAR_FIELDS.map(f => car[f]), ...car.wheels.flatMap(w => [...WHEEL_FIELDS.map(f => w[f]), ...TYRE_FIELDS.map(f => w.tyre[f])])];

const rand = random(seed), uniform = (a, b) => a + (b - a) * rand();
const track0 = new Track(trackId);
const meta = { format: 'pulse-gpu-parity-reference-v1', track: trackId, dt: DT, steps, seconds, seed, fields, inputs: INPUT_FIELDS,
  trackGeometry: { length: track0.length, halfWidth: track0.halfWidth, curbWidth: track0.curbWidth, runoffWidth: track0.runoffWidth,
    barrierOffset: track0.barrierOffset, laneWidth: track0.laneWidth, nodes: track0.nodes.map(n => [n.x, n.z, n.s, n.tx, n.tz, n.curvature]) },
  cases: [] };
const states = new Float64Array(cases * (steps + 1) * fields.length), inputs = new Float64Array(cases * steps * INPUT_FIELDS.length);
const rubber = new Float64Array(cases * track0.rubber.length);

for (let k = 0; k < cases; k++) {
  const track = new Track(trackId);
  // Race weather sets track temperature grip and air temperature every tick; hold them per case.
  track.tempGrip = uniform(.955, 1); track.ambient = uniform(12, 34);
  const classId = rand() < .5 ? 'gt' : 'lmdh', car = new Vehicle(0, 'P', '#fff', classId);
  const wild = rand() < .35, s0 = uniform(0, track.length), lat0 = uniform(-4.5, 4.5), v0 = wild ? uniform(0, 70) : uniform(15, 65);
  car.place(track, s0, lat0, v0);
  car.yaw += wild ? uniform(-.25, .25) : uniform(-.04, .04);
  const grip = uniform(18, 34), wake = rand() < .3 ? uniform(0, .6) : 0, hybrid = classId === 'lmdh' && rand() < .5 ? uniform(0, 3500) : 0;
  let target = uniform(-4, 4), steerNoise = 0, pedalNoise = 0, stab = 0;
  meta.cases.push({ classId, wild, s0, lat0, v0, tempGrip: track.tempGrip, ambient: track.ambient });
  const base = k * (steps + 1) * fields.length;
  states.set(read(car), base);
  for (let t = 0; t < steps; t++) {
    if (rand() < 1 / 240) target = uniform(-5, 5);
    steerNoise = steerNoise * .97 + (rand() - .5) * (wild ? .16 : .04);
    pedalNoise = pedalNoise * .96 + (rand() - .5) * (wild ? .2 : .05);
    const p = track.nearest(car.x, car.z), look = track.at(p.s + 8 + car.speed * .55, target);
    const heading = Math.atan2(look.x - car.x, look.z - car.z);
    let steer = clamp(angle(heading - car.yaw) * 2.4 + steerNoise, -1, 1);
    let ahead = 0;
    for (let d = 10; d <= 120; d += 10) ahead = Math.max(ahead, Math.abs(track.at(p.s + d).curvature));
    const vTarget = Math.min(85, Math.sqrt(grip / Math.max(ahead, 1e-4)));
    let throttle = clamp((vTarget - car.speed) * .25 + pedalNoise, 0, 1), brake = clamp((car.speed - vTarget) * .12 - pedalNoise, 0, 1);
    if (wild) {
      if (stab <= 0 && rand() < 1 / 180) stab = Math.round(uniform(20, 120));
      if (stab > 0) { stab--; brake = 1; throttle = 0; steer = clamp(steer + steerNoise * 4, -1, 1); }
      else if (rand() < .3) throttle = 1;
    }
    car.controls = { throttle, brake, steer };
    car.hybridForce = hybrid * throttle;
    inputs.set([throttle, brake, steer, wake, car.hybridForce], (k * steps + t) * INPUT_FIELDS.length);
    car.step(DT, track, wake);
    states.set(read(car), base + (t + 1) * fields.length);
  }
  rubber.set(track.rubber, k * track0.rubber.length);
}
writeFileSync(resolve(out, 'meta.json'), JSON.stringify(meta));
writeFileSync(resolve(out, 'states.f64'), Buffer.from(states.buffer));
writeFileSync(resolve(out, 'inputs.f64'), Buffer.from(inputs.buffer));
writeFileSync(resolve(out, 'rubber-final.f64'), Buffer.from(rubber.buffer));
console.log(JSON.stringify({ cases, steps, fields: fields.length, wild: meta.cases.filter(c => c.wild).length }));
