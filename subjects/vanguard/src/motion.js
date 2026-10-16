import { Line } from '../../apex/src/line.js';
import { CarModel, liveGrip } from '../../apex/src/model.js';
import lines from '../../apex/data/lines.json' with { type: 'json' };
import { tyreWet } from '../../../game/engine/sim/water.js';
import { clamp, advance, roadSample, gap, angle } from './math.js';

const STEP = 0.1;

/** Cached physical forecast per observed rival, with 2D inertial scrub for spun/stopped hazards. */
export class RivalMotion {
  constructor(course, observer = null) {
    this.course = course;
    this.observer = observer;
    this.guides = new Map();
    this.models = new Map();
  }
  guide(cls) {
    if (cls === this.course.classId) return this.course.line;
    if (!this.guides.has(cls)) {
      const baked = lines[this.course.track.id]?.[cls];
      if (!baked) return this.course.line;
      const line = new Line(this.course.track, { ds: baked.ds, edge: -0.55 });
      line.load(baked);
      const model = new CarModel(cls);
      model.margin = 0.97;
      model.jerk = 40;
      line.speeds(model, { brakeExp: 2, mass: model.sp.mass + 45, notch: false });
      this.guides.set(cls, line);
    }
    return this.guides.get(cls);
  }
  of(r) {
    if (r.motion) return r.motion;
    const track = this.course.track, line = this.guide(r.cls);
    let model = this.models.get(r.cls);
    if (!model) { model = new CarModel(r.cls); this.models.set(r.cls, model); }
    model.grip = liveGrip(r.car).grip * (1 - 0.36 * tyreWet(track, r.car)) * (track.tempGrip ?? 1);
    model.margin = 0.97;
    model.hybrid = Math.max(0, r.car.hybrid?.kw ?? 0);
    let c = line === this.course.line ? r.reference : line.closest(r.car.x, r.car.z, r.reference.i, 20);
    if (c.d2 > 225) c = line.closest(r.car.x, r.car.z, -1);
    const heading = line.heading(c.i, c.f),
      offset = r.d - line.sample(line.lat, c.i, c.f),
      lateralRate = clamp(r.vd - (line.lat[line.idx(c.i + 2)] - line.lat[line.idx(c.i - 2)]) / (4 * line.ds) * r.v, -3, 3);
    const mass = r.car.spec.mass + r.car.fuel * 0.75,
      profileGrip = line === this.course.line ? this.course.model.grip : 1,
      scale = Math.sqrt(clamp(model.grip / Math.max(0.2, profileGrip), 0.35, 1.35));
    let i = c.i, f = c.f, v = Math.max(0, r.car.vx * Math.sin(heading) + r.car.vz * Math.cos(heading)),
      gear = r.car.gear ?? 1, road = r.s;
    const rows = [];
    const count = Math.max(36, Math.ceil(Math.min(8, this.course.options.combatHorizon ?? 3.4) / STEP) + 2);
    for (let n = 0; n < count; n++) {
      const t = n * STEP, s = roadSample(line, i, f, track.length);
      if (n) road += gap(s, road, track.length);
      const d = line.sample(line.lat, i, f) + offset + lateralRate * Math.min(t, 0.7),
        h = line.heading(i, f) + angle(r.car.yaw - heading) * Math.exp(-t / 0.35);
      rows.push({ s: road, d, v, h });
      const limit = line.sample(line.vbrk, i, f, v * 0.12) * scale;
      gear = model.gearAt(v, gear);
      let acceleration = clamp(
        (limit - v) * 2.7,
        -model.brake(v),
        Math.max(0.1, model.driveG(v, gear, mass) + model.towGain(v, r.car.aero?.wake ?? 0))
      );
      if (t < 0.25 && r.car.controls?.brake > 0.15) acceleration = Math.min(acceleration, r.ax);
      const next = Math.max(0, v + acceleration * STEP),
        a = advance(line, i, f, (v + next) * 0.5 * STEP);
      i = a.i; f = a.f; v = next;
    }
    return (r.motion = rows);
  }
  at(r, time) {
    if (r.hazard && (Math.abs(r.psi) > 0.55 || r.car.speed < 7) && this.observer) {
      return this.observer.at(r, time);
    }
    const rows = this.of(r), horizon = (rows.length - 1) * STEP, x = clamp(time / STEP, 0, rows.length - 1),
      i = Math.min(rows.length - 2, Math.floor(x)), f = x - i, a = rows[i], b = rows[i + 1];
    const s = a.s + (b.s - a.s) * f, d = a.d + (b.d - a.d) * f,
      v = a.v + (b.v - a.v) * f, h = a.h + angle(b.h - a.h) * f, q = this.course.track.at(s);
    return {
      s, d, v, h,
      x: q.x + Math.cos(q.heading) * d,
      z: q.z - Math.sin(q.heading) * d,
      vx: Math.sin(h) * v,
      vz: Math.cos(h) * v,
      sigma: 0.15 + 0.12 * Math.min(3.5, time) ** 2,
      valid: time >= 0 && time <= horizon
    };
  }
}
