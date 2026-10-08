import { angle, clamp } from '../../apex/src/math.js';
import { CarModel, liveGrip } from '../../apex/src/model.js';

const wrap = (s, length) => ((s + 1.5 * length) % length) - length / 2;

// Distance belongs to the sampled path. Its station index is shared with the
// base only for ego corridors; a rival class can have a different reference.
export function pathPoint(path, i, f, distance = 0) {
  let left = f * path.len[i] + distance;
  while (left >= path.len[i]) { left -= path.len[i]; i = path.idx(i + 1); }
  while (left < 0) { i = path.idx(i - 1); left += path.len[i]; }
  f = left / Math.max(1e-9, path.len[i]);
  const j = path.idx(i + 1);
  return { i, f, x: path.px[i] + (path.px[j] - path.px[i]) * f,
    z: path.pz[i] + (path.pz[j] - path.pz[i]) * f, yaw: path.heading(i, f) };
}

function roadStation(combat, point, hint) {
  const base = combat.driver.line;
  let p = base.closest(point.x, point.z, hint);
  if (p.d2 > 400) p = base.closest(point.x, point.z);
  return { i: p.i, s: combat.arc[p.i] + p.f * base.len[p.i] };
}

// Fixed-size predictions use public pose, class, tyres and fuel. They do not
// consult the rival's driver, controls to be chosen, or elapsed CPU time.
export function worldForecast(combat, r, t) {
  let cache = r.worldPrediction;
  if (!cache || cache.time !== combat.now) {
    const d = combat.driver, ref = d.shadow(r.cls) ?? d.line, car = r.car;
    let start = ref.closest(car.x, car.z, ref.N === d.line.N ? r.bi : -1);
    if (start.d2 > 400) start = ref.closest(car.x, car.z);
    const origin = pathPoint(ref, start.i, start.f);
    const dx0 = car.x - origin.x - Math.cos(origin.yaw) * start.e;
    const dz0 = car.z - origin.z + Math.sin(origin.yaw) * start.e;
    const lateralVelocity = clamp(car.vx * Math.cos(origin.yaw) - car.vz * Math.sin(origin.yaw), -3, 3);
    const beta = car.speed > 1 ? angle(car.yaw - Math.atan2(car.vx, car.vz)) : 0;
    if (!combat.forecastModels.has(r.cls)) combat.forecastModels.set(r.cls, new CarModel(r.cls));
    const model = combat.forecastModels.get(r.cls);
    model.grip = liveGrip(car).grip * (1 - (d.track.wetness ?? 0) * 0.36) * (d.track.tempGrip ?? 1);
    model.margin = d.model.margin;
    const mass = car.spec.mass + (car.fuel ?? 0) * 0.75, dt = 0.1;
    cache = { time: combat.now, x: new Float64Array(35), z: new Float64Array(35),
      yaw: new Float64Array(35), v: new Float64Array(35), road: new Float64Array(35) };
    cache.x[0] = car.x; cache.z[0] = car.z; cache.yaw[0] = car.yaw;
    cache.v[0] = r.v; cache.road[0] = r.ds;
    const me = combat.me, s0 = combat.arc[me.i] + me.f * d.line.len[me.i];
    let distance = 0, speed = r.v, hint = r.bi;
    for (let j = 1; j < 35; j++) {
      const time = j * dt;
      if (r.hazard) {
        const motion = Math.min(time, 0.7);
        cache.x[j] = car.x + car.vx * motion; cache.z[j] = car.z + car.vz * motion;
        cache.yaw[j] = car.yaw; cache.v[j] = Math.max(0, r.v + Math.min(0, r.a) * time);
      } else {
        const limit = ref.sample(ref.v, start.i, start.f, distance + speed * 0.12);
        const a = clamp((limit - speed) / dt, -model.brake(Math.max(8, speed)), model.driveG(speed, model.gearAt(speed), mass));
        const offset = start.e * Math.exp(-time * 0.2) + lateralVelocity * Math.min(time, 0.5);
        const curvature = ref.sample(ref.ks, start.i, start.f, distance);
        const metric = clamp(1 - curvature * offset, 0.65, 1.4);
        distance += Math.max(0, speed * dt + 0.5 * a * dt * dt) / metric;
        speed = Math.max(0, speed + a * dt);
        const p = pathPoint(ref, start.i, start.f, distance);
        cache.x[j] = p.x + Math.cos(p.yaw) * offset + dx0 * Math.exp(-time / 0.3);
        cache.z[j] = p.z - Math.sin(p.yaw) * offset + dz0 * Math.exp(-time / 0.3);
        const velocityYaw = Math.atan2(cache.x[j] - cache.x[j - 1], cache.z[j] - cache.z[j - 1]);
        cache.yaw[j] = velocityYaw + beta * Math.exp(-time / 0.3); cache.v[j] = speed;
      }
      const road = roadStation(combat, { x: cache.x[j], z: cache.z[j] }, hint); hint = road.i;
      cache.road[j] = wrap(road.s - s0, combat.length);
    }
    r.worldPrediction = cache;
  }
  const at = clamp(t * 10, 0, 34), i = Math.min(33, Math.floor(at)), f = at - i;
  const sample = key => cache[key][i] + (cache[key][i + 1] - cache[key][i]) * f;
  return { x: sample('x'), z: sample('z'), yaw: cache.yaw[i] + angle(cache.yaw[i + 1] - cache.yaw[i]) * f,
    v: sample('v'), ds: sample('road') };
}

export function evaluateWorld(combat, q, car, field, focus) {
  const d = combat.driver, path = q.path, dt = 0.2, horizon = 3.4;
  const bodyHorizon = d.options.bodyHorizon ?? 0.6;
  // Every candidate starts at the same observation time, including the fast
  // line. Control-pose prediction belongs to steering after the decision.
  const origin = path.closest(car.x, car.z, q.i); q.i = origin.i; q.f = origin.f;
  const me = combat.me, s0 = combat.arc[me.i] + me.f * d.line.len[me.i];
  const half = car.spec.halfWidth ?? 0.98, length = car.spec.halfLength ?? 2.28;
  const beta = car.speed > 1 ? angle(car.yaw - Math.atan2(car.vx, car.vz)) : 0;
  let travelled = 0, v = car.speed, risk = 0, overlap = 0, clear = false, front = 0, progress = 0;
  const prior = new Map();
  for (let t = dt; t <= horizon + 0.01; t += dt) {
    const limit = path.sample(path.vbrk, q.i, q.f, travelled + v * 0.12);
    const a = limit > v ? d.model.driveG(v, d.model.gearAt(v), car.spec.mass + car.fuel * 0.75) : -d.model.brake(v);
    v = Math.max(3, Math.min(limit, v + a * dt));
    if (q.kind === 'tow') v += d.model.towGain(v, 0.6) * dt;
    const next = travelled + v * dt, p = pathPoint(path, q.i, q.f, next);
    const yaw = p.yaw + beta * Math.exp(-t / 0.3), sn = Math.sin(yaw), cs = Math.cos(yaw);
    const road = roadStation(combat, p, p.i), roadProgress = wrap(road.s - s0, combat.length);
    for (const r of field.list) {
      if (r.ds > 160 || r.ds < -35) continue;
      const f = worldForecast(combat, r, t), rx = f.x - p.x, rz = f.z - p.z;
      const dx = rx * sn + rz * cs, dy = rx * cs - rz * sn, relativeYaw = f.yaw - yaw;
      const span = length + r.halfLength * Math.abs(Math.cos(relativeYaw)) + r.halfWidth * Math.abs(Math.sin(relativeYaw));
      const width = half + r.halfWidth * Math.abs(Math.cos(relativeYaw)) + r.halfLength * Math.abs(Math.sin(relativeYaw));
      const forward = Math.max(0, f.v * Math.cos(relativeYaw));
      // A stationary obstruction is reliable. A moving rival's driver can
      // change its pace or side before a distant predicted overlap happens.
      const fixed = r.hazard && r.v < 1;
      const confidence = fixed ? 1 : 1 / (1 + (t / bodyHorizon) ** 4);
      const immediate = fixed || t <= bodyHorizon + 1e-8;
      if (dx >= span - 0.8 && dx < span + Math.max(15, v * 1.1) && Math.abs(dy) < width - 0.06) {
        const stopSpeed = Math.sqrt(forward * forward + 2 * d.model.brake(Math.max(8, v)) * Math.max(0, dx - span - 0.3));
        if (stopSpeed < v) {
          if (immediate) v = Math.max(stopSpeed, v - d.model.brake(Math.max(8, v)) * dt);
          front += dt * confidence;
        }
      }
      if (Math.abs(dx) < span + 0.2) {
        const penetration = width - Math.abs(dy);
        if (penetration > (d.options.rubAllowance ?? 0.06)) {
          const closingLat = prior.has(r.id) ? Math.abs(dy - prior.get(r.id)) / dt : 0;
          risk += (penetration - 0.06) ** 2 * dt * confidence * (1 + closingLat * closingLat * 0.15);
          if (dx > 0.3 && dx > span - 1.5) {
            if (immediate) v = Math.min(v, Math.max(2, forward));
            front += dt * confidence;
          }
        }
        if (r.id === focus?.id && Math.abs(dy) > width - 0.15) overlap += dt;
      }
      if (r.id === focus?.id && f.ds - roadProgress < -span - 1 && dx < -span - 1) clear = true;
      prior.set(r.id, dy);
    }
    travelled += v * dt;
    const endpoint = pathPoint(path, q.i, q.f, travelled);
    progress = wrap(roadStation(combat, endpoint, endpoint.i).s - s0, combat.length);
  }
  q.risk = risk; q.clear = clear; q.overlap = overlap; q.progress = progress; q.travelled = travelled;
  q.endGap = focus ? worldForecast(combat, focus, horizon).ds - progress : null;
  const commitment = combat.plan && combat.plan.target === q.target && combat.plan.side === q.side && q.kind !== 'tow' ? 1.6 : 0;
  q.closeSpace = q.kind === 'attack' && focus?.ds > 0 && focus.ds < 10 && risk < 0.1;
  q.score = progress - risk * 14 - front * 4 + (clear ? 4 : 0) + Math.min(2, overlap) + commitment + (q.closeSpace ? 5 : 0);
  return q;
}
