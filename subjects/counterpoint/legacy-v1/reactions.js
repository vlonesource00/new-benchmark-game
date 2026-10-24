import { advance, angle, clamp, ease, gap, roadSample } from '../../vanguard-v2/src/math.js';
import { HALF_WIDTH } from '../../vanguard-v2/src/observer.js';

const MAX_HORIZON = 6;
const RESPONSE_DELAY = 0.55;
const SOURCE_HORIZON = 3.5;
const FORECAST_STEP = 0.1;

function extendFromLastValid(track, pose, poseTime, time) {
  const elapsed = Math.max(0, time - poseTime), v = Math.max(0, pose.v ?? 0),
    s = ((pose.s + v * elapsed) % track.length + track.length) % track.length,
    q = track.at(s), psi = angle((pose.h ?? q.heading) - track.at(pose.s).heading), h = q.heading + psi,
    d = pose.d ?? 0;
  return {
    ...pose,
    s, d, v, h,
    x: q.x + Math.cos(q.heading) * d,
    z: q.z - Math.sin(q.heading) * d,
    vx: Math.sin(h) * v,
    vz: Math.cos(h) * v,
    sigma: (pose.sigma ?? 0) + 0.04 * elapsed,
    valid: true
  };
}

/** Make one immutable, full-horizon view for all counterfactual branches. */
export function extendObserver(observer, track, horizon = 5) {
  const limit = clamp(horizon, 0.1, MAX_HORIZON), motion = observer.motion,
    originalAt = observer.at.bind(observer), byId = new Map(), fallback = new Map(),
    list = observer.list.map(rival => {
      const record = { ...rival }, capacity = rival.motion?.length
        ? (rival.motion.length - 1) * FORECAST_STEP
        : 0;
      if (motion && record.moving && record.reference && record.car?.spec) {
        // Reuse an already long enough forecast; otherwise build on a clone so
        // Vanguard's source observer and its short cache remain unchanged.
        record.motion = capacity + 1e-6 >= limit ? rival.motion : null;
        motion.of(record, limit);
      }
      byId.set(rival.id, record);
      return record;
    }),
    at = (rival, time) => {
      const t = clamp(time, 0, limit), record = byId.get(rival.id) ?? rival;
      let pose = motion && record.moving && record.reference && record.car?.spec
        ? motion.at(record, t)
        : originalAt(rival, t);
      if (pose?.valid !== false || t <= SOURCE_HORIZON) return pose;

      if (!fallback.has(record.id)) {
        let validTime = Math.min(SOURCE_HORIZON, limit), last = originalAt(rival, validTime);
        while (last?.valid === false && validTime > 0) {
          validTime = Math.max(0, validTime - FORECAST_STEP);
          last = originalAt(rival, validTime);
        }
        fallback.set(record.id, { time: validTime, pose: last ?? pose });
      }
      const last = fallback.get(record.id);
      pose = extendFromLastValid(track, last.pose, last.time, t);
      return pose;
    };
  return { ...observer, list, at };
}

function pathLateral(path, point, rival, time) {
  const reference = rival.reference;
  let c;
  if (reference && Number.isFinite(reference.i) && path.ds > 0) {
    const advanceBy = Math.round(Math.max(0, (rival.referenceSpeed ?? rival.v) * time) / path.ds),
      hint = path.idx(reference.i + advanceBy);
    c = path.closest(point.x, point.z, hint, 22);
    if (c.d2 > 225) c = path.closest(point.x, point.z);
  } else {
    c = path.closest(point.x, point.z);
  }
  return path.sample(path.lat, c.i, c.f);
}

function poseAt(track, s, d, v, original) {
  const q = track.at(s), psi = angle((original.h ?? 0) - track.at(original.s).heading),
    h = q.heading + psi;
  return {
    ...original,
    s, d, v, h,
    x: q.x + Math.cos(q.heading) * d,
    z: q.z - Math.sin(q.heading) * d,
    vx: Math.sin(h) * v,
    vz: Math.cos(h) * v
  };
}

/**
 * Small public-state response envelope. Every branch wraps Observer.at and
 * returns fresh poses; source cars, observations, and forecast rows stay read-only.
 */
export class CounterpointReactions {
  constructor(track) {
    this.track = track;
    this.reset();
  }

  reset() {
    this.evidence = { samples: 0, lateral: 0, braking: 0 };
  }

  observe(observer) {
    let lateral = 0, braking = 0;
    for (const rival of observer.list) {
      if (!rival.eligible || !rival.physical || rival.pit || rival.hazard) continue;
      if (Math.abs(rival.offsetSpeed ?? rival.vd ?? 0) > 0.45) lateral++;
      if ((rival.deceleration ?? 0) > 1.5) braking++;
    }
    this.evidence.samples = Math.min(64, this.evidence.samples + observer.list.length);
    this.evidence.lateral = Math.min(64, this.evidence.lateral + lateral);
    this.evidence.braking = Math.min(64, this.evidence.braking + braking);
  }

  branches(path, car, course, observer, target, { maxBranches = 3, horizon = 5 } = {}) {
    const count = clamp(Math.trunc(maxBranches), 1, 3), limit = clamp(horizon, 0.1, MAX_HORIZON),
      current = path?.closest(car.x, car.z), egoCache = new Map(), laneCache = new Map(), egoRows = [],
      egoAt = time => {
        const key = Math.round(time * 100);
        if (egoCache.has(key)) return egoCache.get(key);
        if (!egoRows.length) {
          let cursor = current, speed = car.speed, gear = car.gear ?? 4;
          const model = course.model, mass = (car.spec?.mass ?? 1300) + (car.fuel ?? 50) * .75;
          for (let step = 0; step <= Math.ceil(limit / FORECAST_STEP) + 1; step++) {
            egoRows.push({ ...cursor, speed });
            const cap = path.sample(path.vbrk, cursor.i, cursor.f),
              acceleration = model ? clamp((cap - speed) * 2.7, -model.brake(speed),
                Math.max(.1, model.driveG(speed, gear, mass))) : 0,
              next = Math.max(1, speed + acceleration * FORECAST_STEP);
            cursor = advance(path, cursor.i, cursor.f, (speed + next) * .5 * FORECAST_STEP);
            speed = next;
            if (model) gear = model.gearAt(speed, gear);
          }
        }
        const point = egoRows[Math.min(egoRows.length - 1, Math.round(time / FORECAST_STEP))],
          pose = {
            s: roadSample(path, point.i, point.f, course.track.length),
            d: path.sample(path.lat, point.i, point.f), v: point.speed
          };
        egoCache.set(key, pose);
        return pose;
      },
      laneAt = (rival, point, time) => {
        const key = `${rival.id}:${Math.round(time * 100)}`;
        if (!laneCache.has(key)) laneCache.set(key, pathLateral(path, point, rival, time));
        return laneCache.get(key);
      },
      baseAt = (rival, time) => observer.at(rival, Math.min(limit, Math.max(0, time))),
      hold = { kind: 'hold', observer: { list: observer.list, me: observer.me, car: observer.car, at: baseAt } };
    if (count === 1 || !path?.attackSide || !target?.eligible || target.pit || target.hazard)
      return [hold];

    const responders = new Set([target.id, ...observer.list.filter(r => r.eligible && !r.pit && !r.hazard)
      .sort((a, b) => Math.abs(a.ds) - Math.abs(b.ds)).map(r => r.id)].filter((id, i, ids) => ids.indexOf(id) === i).slice(0, 3));
    const makeObserver = kind => {
      const trajectories = new Map();
      const trajectory = rival => {
        if (trajectories.has(rival.id)) return trajectories.get(rival.id);
        const rows = []; let admitted = null, loss = 0, previousDv = 0;
        for (let n = 0; n <= Math.ceil(limit / FORECAST_STEP) + 1; n++) {
          const t = Math.min(limit, n * FORECAST_STEP), original = baseAt(rival, t), ego = egoAt(t),
            ahead = gap(original.s, ego.s, course.track.length);
          if (!admitted && t > RESPONSE_DELAY && ahead > .25 && ahead < 44 && ego.v >= original.v - .8) {
            const delta = laneAt(rival, original, t) - original.d;
            if ((kind === 'cover' && Math.abs(delta) <= 3.6) ||
                (kind === 'brake' && Math.abs(delta) <= 2.8 && ahead > 2 && ahead < 30)) {
              admitted = { time: t, shift: clamp(delta, -.58, .58) };
            }
          }
          let offset = 0, dv = 0;
          if (admitted) {
            const elapsed = Math.max(0, t - admitted.time);
            if (kind === 'cover') {
              // Admit once and retain the displacement through overlap. Never
              // teleport back to nominal when the longitudinal gap changes sign.
              const edge = Math.max(Math.abs(original.d), course.track.halfWidth - HALF_WIDTH - .12);
              offset = clamp(original.d + admitted.shift * ease(elapsed / 1.35), -edge, edge) - original.d;
            } else dv = Math.min(Math.max(0, original.v - 6), 2.4 * ease(elapsed / 2));
          }
          if (n) loss += (previousDv + dv) * .5 * Math.max(0, t - rows.at(-1).t);
          previousDv = dv;
          rows.push({ t, original, offset, dv, loss });
        }
        trajectories.set(rival.id, rows); return rows;
      };
      return {
      list: observer.list,
      me: observer.me,
      car: observer.car,
      at: (rival, time) => {
        const t = Math.min(limit, Math.max(0, time)), original = baseAt(rival, t);
        if (!responders.has(rival.id) || !rival.eligible || !rival.physical || rival.pit || rival.hazard || original.valid === false || t <= RESPONSE_DELAY)
          return original;
        const rows = trajectory(rival), i = Math.min(rows.length - 2, Math.floor(t / FORECAST_STEP)),
          a = rows[i], b = rows[i + 1], f = clamp((t - a.t) / Math.max(1e-9, b.t - a.t), 0, 1),
          mix = key => a[key] + (b[key] - a[key]) * f;
        if (kind === 'cover') {
          const offset = mix('offset'), rate = (b.offset - a.offset) / Math.max(1e-9, b.t - a.t);
          if (offset === 0 && rate === 0) return original;
          const result = poseAt(course.track, original.s, original.d + offset, original.v, original);
          result.h += Math.atan2(rate, Math.max(8, original.v));
          result.vx = Math.sin(result.h) * result.v;
          result.vz = Math.cos(result.h) * result.v;
          return result;
        }
        const loss = mix('loss'), dv = mix('dv');
        if (loss === 0 && dv === 0) return original;
        const s = ((original.s - loss) % course.track.length + course.track.length) % course.track.length;
        return poseAt(course.track, s, original.d, Math.max(0, original.v - dv), original);
      }
      };
    };

    const branches = [hold, { kind: 'cover', observer: makeObserver('cover') }];
    if (count > 2) branches.push({ kind: 'brake', observer: makeObserver('brake') });
    return branches;
  }
}
