// Public physical observations only. No racing-line targets, teacher plans or IDs.
import { TANK_LITRES } from '../../../game/core/rules.js';
export const VERSION = 'pulse-observation-v1';
export const RIVALS = 8;
export const PREVIEW = [0, .15, .3, .5, .75, 1, 1.3, 1.7, 2.2, 2.8, 3.5, 4.2];
const f = (name, scale = 1, min = -1, max = 1) => ({ name, scale, min, max });
const bit = name => f(name, 1, 0, 1);
const ego = [f('speed', 100, 0), f('forwardSpeed', 100), f('sideSpeed', 20), f('headingSin'), f('headingCos'),
  f('yawRate', 2), f('ax', 25), f('ay', 40), f('roadOffset', 15), f('steering'),
  f('previousSteer'), f('previousLongitudinal'), f('heldSteer'), f('heldLongitudinal'), f('dt', .1, 0), f('actionAge', .5, 0),
  f('fuelFraction', 1, 0), f('batteryFraction', 1, 0), f('damage', 1, 0), bit('gtp'),
  f('lapsLeft', 30, 0), f('stintLaps', 15, 0), f('lapsToTyres', 15, 0), bit('pitCalled'),
  bit('formation'), bit('yellow'), bit('safetyCar'), bit('fullYellow'), bit('pitLane'),
  f('wake', 1, 0), f('wetness', 1, 0), f('trackTemperature', 60, 0),
  bit('absActive'), bit('tcActive'), bit('soft'), bit('medium'), bit('hard'), bit('inter'), bit('wet')];
const tyre = [f('coreMinusOptimum', 50), f('wear', 1, 0), f('load', 10000, 0), f('slipAngle', .4),
  f('slipRatio', 1), f('spinSpeed', 500), f('slipPower', 100000, 0), f('brakeTemperature', 1000, 0)];
const road = [f('distance', 400, 0), f('right', 120), f('forward', 400), f('headingSin'), f('headingCos'),
  f('curvature', .05), f('grade', .25), f('halfWidth', 20, 0), f('grip', 2, 0),
  f('waterLeft', 5, 0), f('waterMiddle', 5, 0), f('waterRight', 5, 0)];
const rival = [bit('mask'), f('gap', 250), f('right', 40), f('forward', 250), f('relativeForwardSpeed', 80),
  f('relativeSideSpeed', 20), f('headingSin'), f('headingCos'), f('yawRate', 2), f('speed', 100, 0),
  bit('gtp'), bit('offRoad'), bit('stopped'), bit('pitApproach'), bit('finished'), f('damage', 1, 0),
  f('halfWidth', 3, 0), f('halfLength', 5, 0)];
const fields = [], groups = {};
function group(name, definition, count = 1) {
  groups[name] = { offset: fields.length, width: definition.length, count, size: definition.length * count };
  for (let i = 0; i < count; i++) for (const field of definition) fields.push({ ...field, name: `${name}${count > 1 ? '.' + i : ''}.${field.name}` });
}
group('ego', ego); group('tyres', tyre, 4); group('road', road, PREVIEW.length); group('rivals', rival, RIVALS);
export const SCHEMA = { version: VERSION, size: fields.length, groups, fields, previewSeconds: PREVIEW, action: ['steer', 'signedLongitudinal'], hidden: 128 };
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const angle = a => Math.atan2(Math.sin(a), Math.cos(a));
export const gap = (a, b, length) => ((a - b + length * 1.5) % length) - length * .5;
export const toAction = c => [c.steer ?? 0, (c.throttle ?? 0) - (c.brake ?? 0)];
export function toControls(action) {
  const steer = clamp(action[0], -1, 1), longitudinal = clamp(action[1], -1, 1);
  return { steer, throttle: Math.max(0, longitudinal), brake: Math.max(0, -longitudinal) };
}

export function observe(race, car, { dt = 1 / 60, previous = [0, 0], actionAge = 0 } = {}) {
  const track = race.track, at = track.nearest(car.x, car.z), entry = race.entryOf(car), psi = angle(car.yaw - at.heading);
  const held = toAction(car.controls), raw = [], rejected = [], selected = [];
  const flag = race.stewards?.flagFor(entry, race.stewards.hazards());
  const caution = race.caution?.active ? race.caution.phase : null;
  const compound = car.wheels[0].tyre.compound;
  const local = (x, z) => ({ right: (x - car.x) * at.nx + (z - car.z) * at.nz, forward: (x - car.x) * at.tx + (z - car.z) * at.tz });
  const vf = car.vx * at.tx + car.vz * at.tz, vs = car.vx * at.nx + car.vz * at.nz;
  const nextTyre = entry.strategist.nextTyreLap;
  raw.push(car.speed, vf, vs, Math.sin(psi), Math.cos(psi), car.yawRate, car.ax, car.ay, at.lateral,
    car.steering, ...previous, ...held, dt, actionAge, car.fuel / TANK_LITRES, (car.hybrid?.energy ?? 0) / 3e6, car.damage,
    +(car.classId === 'lmdh'), race.lapsLeft(car), entry.strategist.stintLaps,
    Number.isFinite(nextTyre) ? Math.max(0, nextTyre - car.race.lap) : race.lapsLeft(car), +!!entry.pitPlan,
    +!!race.formation, +(flag === 'yellow'), +(caution === 'sc'), +(caution === 'fcy'), +(!!entry.pit && entry.pit.phase !== 'approach'),
    car.aero?.wake ?? 0, track.wetness, track.temperature, +!!car.absActive, +!!car.tcActive,
    ...['soft', 'medium', 'hard', 'inter', 'wet'].map(x => +(x === compound)));
  for (const w of car.wheels) {
    const t = w.tyre;
    raw.push(t.core - t.optimum, t.wear, w.load, t.alpha, t.kappa, w.omega, t.slipPower, w.brakeTemp);
  }
  const preview = [];
  for (const seconds of PREVIEW) {
    const distance = seconds * Math.max(15, car.speed), p = track.at(at.s + distance), v = local(p.x, p.z);
    const l = track.at(p.s, -track.halfWidth * .65), r = track.at(p.s, track.halfWidth * .65);
    const middle = track.surface(p.x, p.z), left = track.surface(l.x, l.z), right = track.surface(r.x, r.z);
    const h = angle(p.heading - at.heading), grade = distance > .1 ? (p.y - at.y) / distance : 0;
    raw.push(distance, v.right, v.forward, Math.sin(h), Math.cos(h), p.curvature, grade, track.halfWidth,
      middle.grip, left.water, middle.water, right.water);
    preview.push({ ...p, distance, halfWidth: track.halfWidth });
  }
  const candidates = [];
  for (const other of race.cars) {
    if (other === car) continue;
    const e = race.entryOf(other), p = track.nearest(other.x, other.z), v = local(other.x, other.z);
    const pit = e.pit && e.pit.phase !== 'approach', retired = e.retired || other.race.retired || other.race.dq;
    if (pit || retired || other.ghost) { rejected.push({ id: other.id, reason: pit ? 'pit' : retired ? 'retired' : 'ghost' }); continue; }
    if (Math.hypot(v.right, v.forward) > 250) continue;
    const off = Math.abs(p.lateral) > track.halfWidth + .8, heading = angle(other.yaw - at.heading);
    const relF = (other.vx - car.vx) * at.tx + (other.vz - car.vz) * at.tz;
    // Nearby hazards stay visible even off-road. Pit approach is explicit, never a tow/pass target.
    const priority = Math.abs(v.forward) + Math.abs(v.right) * 2 - (v.forward > 0 && relF < 0 ? 30 : 0);
    candidates.push({ other, p, v, off, heading, relF, priority, entry: e });
  }
  candidates.sort((a, b) => a.priority - b.priority || a.other.id - b.other.id);
  for (let i = 0; i < RIVALS; i++) {
    const c = candidates[i];
    if (!c) { raw.push(...new Array(groups.rivals.width).fill(0)); continue; }
    const { other: o, p, v, entry: e } = c;
    raw.push(1, gap(p.s, at.s, track.length), v.right, v.forward, c.relF,
      (o.vx - car.vx) * at.nx + (o.vz - car.vz) * at.nz, Math.sin(c.heading), Math.cos(c.heading), o.yawRate, o.speed,
      +(o.classId === 'lmdh'), +c.off, +(o.speed < 5), +(!!e.pitPlan || e.pit?.phase === 'approach'),
      +(o.race.finishTime !== null), o.damage, o.spec.halfWidth, o.spec.halfLength);
    selected.push({ id: o.id, slot: i, gap: gap(p.s, at.s, track.length), pitApproach: !!e.pitPlan || e.pit?.phase === 'approach', offRoad: c.off });
  }
  if (raw.length !== SCHEMA.size) throw Error(`Observation length ${raw.length}, expected ${SCHEMA.size}`);
  const clipped = [], missing = [];
  const normalized = raw.map((v, i) => {
    if (!Number.isFinite(v)) { missing.push(fields[i].name); raw[i] = 0; v = 0; }
    const f = fields[i], x = v / f.scale;
    if (x < f.min || x > f.max) clipped.push(f.name);
    return clamp(x, f.min, f.max);
  });
  return { raw, normalized, selected, rejected, clipped, missing, preview, road: { s: at.s, lateral: at.lateral, heading: at.heading } };
}
