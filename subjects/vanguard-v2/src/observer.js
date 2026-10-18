import { angle, gap, clamp, advance, roadSample } from './math.js';

export const HALF_LENGTH = 2.28;
export const HALF_WIDTH = 0.98;
export const ROAD_BRAKE_LIMIT = 18;

function forwardMotion(v, a, time) {
  v = Math.max(0, v);
  const applied = Math.min(time, 1, a < 0 ? v / -a : Infinity),
    end = Math.max(0, v + a * applied);
  return { distance: v * applied + 0.5 * a * applied * applied + end * (time - applied), velocity: end };
}

/** Public observations only. Strict pit-car immunity: cars in pit entry/lane/service/exit are never physical, eligible, or hazards. */
export class Observer {
  constructor(track) {
    this.track = track;
    this.history = new Map();
    this.list = [];
  }
  reset() {
    this.history.clear();
    this.list = [];
    this.meReference = -1;
  }
  update(car, cars, state = {}, now = 0) {
    const t = this.track, me = t.nearest(car.x, car.z), hp = t.at(me.s).heading;
    this.me = { s: me.s, d: me.lateral, v: car.speed, h: hp };
    if (this.reference) {
      let c = this.reference.closest(car.x, car.z, this.meReference ?? -1, 20);
      if (c.d2 > 225) c = this.reference.closest(car.x, car.z, -1);
      this.meReference = c.i;
      this.me.offset = c.e;
    }
    this.car = car;
    this.list.length = 0;
    for (const other of cars) {
      if (!other || other === car || (other.ghost && car.ghost)) continue;
      const q = t.nearest(other.x, other.z), ds = gap(q.s, me.s, t.length);
      if (Math.abs(ds) > Math.max(155, car.speed * 3.6) && Math.hypot(other.x - car.x, other.z - car.z) > 110) continue;
      const meta = state.rivals?.find(r => r.id === other.id), h = t.at(q.s).heading;
      const psi = angle(other.yaw - h), v = other.vx * Math.sin(h) + other.vz * Math.cos(h);
      const vd = other.vx * Math.cos(h) - other.vz * Math.sin(h), old = this.history.get(other.id);
      const elapsed = old ? now - old.time : 0;
      const ax = elapsed > 0.008 && elapsed < 0.5 ? clamp((v - old.v) / elapsed, -ROAD_BRAKE_LIMIT, 8) : 0;
      const bodySpeed = Math.hypot(other.vx, other.vz),
        deceleration = elapsed > 0.008 && elapsed < 0.5 && Number.isFinite(old?.bodySpeed)
          ? clamp((old.bodySpeed - bodySpeed) / elapsed, 0, 60)
          : 0;
      const rawPit = meta?.pit ?? (typeof other.pit === 'object' ? other.pit?.state : other.pit) ?? other.pitState ?? null;
      // Strict Pit-Car Immunity: any car in pit entry, lane, service, or exit is completely ignored as physical, eligible, or hazard.
      const pit = Boolean(rawPit && rawPit !== 'none' && rawPit !== 'approach');
      const approaching = !pit && Boolean(meta?.boxCalled || rawPit === 'approach' || other.race?.boxThisLap);
      const retired = meta?.retired || other.race?.retired || other.race?.disqualified;
      const done = Number.isFinite(other.race?.finishTime), off = Math.abs(q.lateral) > t.halfWidth + 0.8;
      const reenter = !pit && off && (q.lateral * vd < -0.4);
      const physical = !pit && (!off || reenter || Math.abs(q.lateral - me.lateral) < 3);
      const eligible = !pit && !approaching && !retired && !done && !off && v >= 7 && Math.abs(psi) < 0.65;
      let paceRatio = old?.paceRatio ?? 1;
      const r = {
        id: other.id, car: other, cls: other.classId, s: q.s, d: q.lateral, ds, v, vd, ax, deceleration,
        accelerationValid: elapsed > 0.008 && elapsed < 0.5,
        psi,
        along: Math.abs(Math.cos(psi)) * HALF_LENGTH + Math.abs(Math.sin(psi)) * HALF_WIDTH,
        across: Math.abs(Math.cos(psi)) * HALF_WIDTH + Math.abs(Math.sin(psi)) * HALF_LENGTH,
        physical, eligible, retired: Boolean(retired), pit, approaching, done, off, reenter,
        moving: v >= 7 && Math.abs(psi) < 0.65 && !pit && !approaching && !retired && !done,
        hazard: !pit && (done || retired || off || Math.abs(psi) > 0.65 || v < 7 || (!eligible && physical && !approaching)),
        kind: pit ? 'pit' : eligible ? (other.classId === car.classId ? 'race' : 'traffic') : 'hazard',
        paceRatio
      };
      let pathOffset = old?.pathOffset ?? null, pathVel = old?.pathVel ?? null;
      if (this.reference) {
        const line = this.reference, n = line.N;
        if (!pathOffset || pathOffset.length !== n) {
          pathOffset = new Float32Array(n).fill(NaN);
          pathVel = new Float32Array(n).fill(NaN);
        }
        let c = line.closest(other.x, other.z, old?.referenceIndex ?? -1, Math.max(14, Math.ceil(Math.max(0, elapsed) * other.speed / line.ds) + 8));
        if (c.d2 > 225) c = line.closest(other.x, other.z, -1);
        const d = line.sample(line.lat, c.i, c.f),
          slope = (line.lat[line.idx(c.i + 2)] - line.lat[line.idx(c.i - 2)]) / (4 * line.ds);
        const h = line.heading(c.i, c.f);
        r.reference = c;
        r.offset = c.e;
        r.roadOffset = q.lateral - d;
        r.roadOffsetSpeed = clamp(vd - slope * v, -3, 3);
        r.offsetSpeed = clamp(other.vx * Math.cos(h) - other.vz * Math.sin(h), -3, 3);
        r.referenceSpeed = other.vx * Math.sin(h) + other.vz * Math.cos(h);
        r.coursePsi = angle(other.yaw - h);
        r.courseAcross = Math.abs(Math.cos(r.coursePsi)) * HALF_WIDTH + Math.abs(Math.sin(r.coursePsi)) * HALF_LENGTH;
        if (!pit && Math.abs(r.coursePsi) < 0.65 && r.referenceSpeed >= 7) {
          r.moving = !pit && !approaching && !retired && !done;
          r.eligible = r.moving && !off;
          r.hazard = !pit && physical && (off || retired || done || (!r.eligible && !approaching));
          r.kind = r.eligible ? (other.classId === car.classId ? 'race' : 'traffic') : 'hazard';
        }
        // Learn rival station path and straight-line governed paceRatio (never learn downward mid-corner)
        if (r.eligible && r.referenceSpeed > 8) {
          if (old?.referenceIndex != null && old.referenceIndex !== c.i) {
            for (let j = (old.referenceIndex + 1) % n, k = 0; k < 8; j = (j + 1) % n, k++) {
              pathOffset[j] = Number.isNaN(pathOffset[j]) ? r.offset : 0.5 * (pathOffset[j] + r.offset);
              pathVel[j] = Number.isNaN(pathVel[j]) ? r.referenceSpeed : 0.5 * (pathVel[j] + r.referenceSpeed);
              if (j === c.i) break;
            }
          }
          const kRoad = Math.max(Math.abs(line.sample(line.ks, c.i, c.f)), Math.abs(line.sample(line.ks, c.i, c.f, 36)));
          const vAhead = line.sample(line.vbrk, c.i, c.f, 45);
          const drv = other.spec?.drive === 'front' ? 0 : 2;
          const spin = other.wheels ? Math.max(other.wheels[drv]?.tyre?.kappa ?? 0, other.wheels[drv + 1]?.tyre?.kappa ?? 0) : 0;
          const straight = kRoad < 0.0012 && vAhead > r.referenceSpeed + 3 && spin < 0.16 &&
            Math.abs(other.controls?.steer ?? 0) < 0.04 && Math.abs(r.coursePsi) < 0.06;
          if (old && elapsed > 0 && now > 0.5 && straight && r.referenceSpeed > 28) {
            const refSpeed = Math.max(8, line.sample(line.v ?? line.vbrk, c.i, c.f));
            const pr = clamp(r.referenceSpeed / refSpeed, 0.75, 1.15);
            const throttle = other.controls?.throttle ?? 0, brake = other.controls?.brake ?? 0;
            if (brake < 0.02 && ((throttle > 0.05 && throttle < 0.94 && ax > -0.5 && ax < 3.2) || pr > paceRatio)) {
              const dtLearn = clamp(elapsed, 0.01, 0.25);
              paceRatio += (pr - paceRatio) * Math.min(1, dtLearn * 1.8);
            }
          }
        }
        r.paceRatio = paceRatio;
        r.pathOffset = pathOffset;
        r.pathVel = pathVel;
      }
      this.list.push(r);
      this.history.set(other.id, {
        time: now, v, bodySpeed, d: q.lateral,
        referenceIndex: r.reference?.i, paceRatio, pathOffset, pathVel
      });
    }
    this.list.sort((a, b) => Math.abs(a.ds) - Math.abs(b.ds));
    return this;
  }
  /** Near-term body tube; uses 2D inertial scrub for spun/sideways hazards so stationary/sideways cars don't drift down-track. */
  at(r, time) {
    if (this.motion && r.moving && r.reference && r.car?.spec) return this.motion.at(r, time);
    return this.inertialAt(r, time);
  }
  inertialAt(r, time) {
    const h = Math.min(3.5, Math.max(0, time));
    if (r.hazard && (Math.abs(r.psi) > 0.55 || r.v < 5)) {
      const speed0 = Math.hypot(r.car.vx ?? 0, r.car.vz ?? 0), decel = 9.0;
      const tStop = speed0 > 0.05 ? Math.min(h, speed0 / decel) : 0;
      const dist = speed0 * tStop - 0.5 * decel * tStop * tStop;
      const ux = speed0 > 0.05 ? r.car.vx / speed0 : 0, uz = speed0 > 0.05 ? r.car.vz / speed0 : 0;
      const x = r.car.x + ux * dist, z = r.car.z + uz * dist;
      const remV = Math.max(0, speed0 - decel * h);
      const q = this.track.nearest(x, z), hd = this.track.at(q.s).heading;
      return {
        s: q.s, d: q.lateral, v: (ux * Math.sin(hd) + uz * Math.cos(hd)) * remV,
        x, z, h: r.car.yaw,
        vx: ux * remV, vz: uz * remV,
        sigma: 0.12 + 0.08 * h * h,
        valid: time <= 3.5
      };
    }
    const acceleration = r.hazard ? Math.min(0, r.ax) : clamp(r.ax, -8, 4);
    const motion = forwardMotion(r.v, acceleration, h), ds = motion.distance;
    let road = r.s + ds;
    let lateral = r.d + clamp(r.vd, -3, 3) * Math.min(h, 0.7);
    const referenceDistance = this.reference && r.reference ? forwardMotion(r.referenceSpeed, acceleration, h).distance : 0;
    if (this.reference && !r.hazard && !r.approaching && r.reference) {
      const line = this.reference, c = advance(line, r.reference.i, r.reference.f, referenceDistance);
      road = roadSample(line, c.i, c.f, this.track.length);
      lateral = line.sample(line.lat, c.i, c.f) + (r.roadOffset ?? r.offset) + (r.roadOffsetSpeed ?? r.offsetSpeed) * Math.min(h, 0.7);
    }
    const q = this.track.at(road), velocity = motion.velocity;
    let heading = q.heading + r.psi;
    if (this.reference && !r.hazard && !r.approaching && r.reference) {
      const c = advance(this.reference, r.reference.i, r.reference.f, referenceDistance);
      heading = this.reference.heading(c.i, c.f);
    }
    return {
      s: road, d: lateral, v: velocity,
      x: q.x + Math.cos(q.heading) * lateral,
      z: q.z - Math.sin(q.heading) * lateral,
      h: heading,
      vx: Math.sin(heading) * velocity,
      vz: Math.cos(heading) * velocity,
      sigma: 0.15 + 0.12 * h * h,
      valid: time <= 3.5
    };
  }
}
