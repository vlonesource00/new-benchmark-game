import { Controller } from './controller.js';
import { HeldPredictor } from './predict.js';
import { bodyContact } from './body.js';
import { HALF_LENGTH } from './observer.js';
import { angle, clamp, gap, advance } from './math.js';
import { wakes } from '../../../game/engine/sim/vehicle.js';
import { halfCarInside } from '../../../game/engine/sim/racecraft-policy.js';
import { hybridStep } from '../../../game/core/hybrid.js';
import { deployment } from './strategy.js';

/** Include the exit of the next braking corner, within a bounded CPU budget.
 * All alternatives, including returning to the base line, use the SAME clock. */
export function tacticalHorizon(line, car) {
  const c = line.closest(car.x, car.z);
  let time = 0, peak = 0, apex = 0;
  for (let distance = 12; distance <= 430; distance += 12) {
    const p = advance(line, c.i, c.f, distance), k = Math.abs(line.sample(line.ks, p.i, p.f));
    time += 12 / Math.max(12, Math.min(Math.max(20, car.speed), line.sample(line.vbrk, p.i, p.f)));
    if (time > 6.5) break;
    if (k > Math.max(0.0025, peak)) { peak = k; apex = distance; }
    if (peak && distance > apex + 35 && k < peak * 0.55) return clamp(time + 0.5, 4.5, 6.5);
  }
  return peak ? 6.5 : 4.5;
}

/** A private copy of the game's actual vehicle and the live force controller.
 * Rivals remain forecasts, NOT omniscient copies of another driver's brain.
 * No collision impulses are invented to make a pass succeed: contact is a
 * risk/cost, and hard impacts or illegal/untrackable corridors are rejected. */
export class TrajectoryRollout {
  constructor(course) {
    this.course = course;
    this.plant = new HeldPredictor(course.track);
    this.controller = new Controller(course.options);
  }
  evaluate(path, car, source, target, horizon = tacticalHorizon(this.course.line, car)) {
    const course = this.course, track = course.track, model = course.model,
      predicted = this.plant.begin(car), controller = this.controller, dt = 1 / 120;
    controller.reset();
    // A candidate begins with the steering curvature and acceleration already
    // in flight. Changing route cannot instantly reset tyre/actuator memory.
    for (const key of ['kc', 'acceleration', 'sideYield']) {
      const memory = course.controlMemory ?? course.controller;
      if (memory?.[key] !== undefined) controller[key] = memory[key];
    }
    const originals = source.list.filter(r => r.physical && !r.pit);
    for (const r of originals) source.motion?.of(r, horizon + 1.1);
    const list = originals.map(r => ({ ...r, original: r, car: { ...r.car, controls: { ...r.car.controls } } }));
    let time = 0;
    const observer = { list, me: {},
      at: (r, ahead) => source.at(r.original, time + ahead) };
    const previewCourse = Object.create(course); previewCourse.track = this.plant.surface;
    const peaks = new Map(), initial = path.closest(car.x, car.z), startS = source.me.s;
    let risk = 0, rubbingDamage = 0, hardImpact = false, threat = null, peakRisk = 0,
      blocked = 0, clearSeconds = 0, everCleared = false, offtrack = 0, maxError = Math.abs(initial.e),
      road = startS, previousRoad = startS, finalGap = target?.ds ?? 0, rival = null, validForecast = true;
    const bodies = [predicted, ...list.map(r => r.car)];
    while (time < horizon - 1e-9) {
      const h = Math.min(dt, horizon - time), q = track.nearest(predicted.x, predicted.z), heading = track.at(q.s).heading;
      Object.assign(observer.me, { s: q.s, d: q.lateral, h: heading, v: predicted.speed });
      for (const r of list) {
        const p = source.at(r.original, time);
        validForecast &&= p.valid !== false;
        Object.assign(r.car, { x: p.x, z: p.z, yaw: p.h, vx: p.vx, vz: p.vz, speed: p.v });
        // A measured brake input belongs to the snapshot, not every future
        // second. Use the forecast's changing speed after its observed prefix.
        const next = source.at(r.original, time + 0.1), ax = (next.v - p.v) / 0.1;
        r.ax = ax;
        r.deceleration = time < 0.2 ? Math.max(0, r.original.deceleration ?? 0, -ax) : Math.max(0, -ax);
        r.car.controls.brake = time < 0.2 ? (r.original.car.controls?.brake ?? 0) :
          clamp(-ax / Math.max(3, model.brake(Math.max(5, p.v))), 0, 1);
        Object.assign(r, { s: p.s, d: p.d, ds: gap(p.s, q.s, track.length), v: p.v,
          vd: p.vx * Math.cos(heading) - p.vz * Math.sin(heading), psi: angle(p.h - heading) });
      }
      const wake = wakes(bodies)[0];
      controller.step(predicted, path, previewCourse, observer, h, {
        time, returning: !path.attackSide && Math.abs(initial.e) > 0.35
      });
      if (predicted.hybrid) {
        const { deploy } = deployment(predicted.hybrid.energy / 3e6, predicted.speed, {
          fight: Boolean(path.attackSide && target?.eligible && Math.abs(finalGap) < 24),
          exit: controller.trace.feed > 0 || controller.targetSpeed > predicted.speed + 1,
          ...predicted.controls, source: controller.trace.source
        });
        predicted.intent = { deploy, harvest: predicted.hybrid.energy / 3e6 < 0.35 ? 0.8 : 0.35, ttl: 0.25 };
        hybridStep(predicted, h);
      }
      predicted.step(h, this.plant.surface, wake);
      time += h;
      const pose = track.nearest(predicted.x, predicted.z);
      road += gap(pose.s, previousRoad, track.length); previousRoad = pose.s;
      maxError = Math.max(maxError, Math.abs(controller.e));
      if (!halfCarInside(Math.abs(predicted.lateral) - predicted.spec.track / 2,
        track.halfWidth + (track.curbWidth ?? 0))) offtrack += h;
      if (controller.trace.nose !== null) blocked += h;
      const body = { x: predicted.x, z: predicted.z, h: predicted.yaw, vx: predicted.vx, vz: predicted.vz };
      for (const r of list) {
        const p = source.at(r.original, time), contact = bodyContact(body, p, path.contactMargin ?? 0.08);
        if (contact) {
          const { depth, closing, longitudinal } = contact;
          // Near-term collisions are a hard constraint. Beyond the old 3.4 s
          // contact horizon, independent rival forecasts become uncertain;
          // retain a soft cost instead of treating a late crossing as certain.
          if (time <= 3.4 && depth > 0.16 && (closing > 6 || (longitudinal > 0.65 && closing > 3.5))) hardImpact = true;
          const rub = course.racecraft?.contactRisk(body, p, contact, r.hazard, h, peaks.get(r.id) ?? 0);
          if (rub) { rubbingDamage += rub.damage; peaks.set(r.id, Math.max(peaks.get(r.id) ?? 0, closing)); }
          else peaks.delete(r.id);
          const cost = rub?.risk ?? h * (Math.max(0, depth - 0.12) * 1.2 +
            Math.max(0, closing - 1.5) ** 2 * (longitudinal > 0.65 ? 0.6 : 0.16) + (r.hazard || closing > 6 ? 20 : 0));
          risk += cost * Math.exp(-Math.max(0, time - 3.4));
          if (cost > peakRisk) { peakRisk = cost; threat = r.id; }
        } else peaks.delete(r.id);
        if (r.id === target?.id) {
          rival = p; finalGap = gap(p.s, pose.s, track.length);
          const clear = finalGap < -(HALF_LENGTH + r.along + 0.2);
          clearSeconds = clear ? clearSeconds + h : 0;
          everCleared ||= clear;
        }
      }
    }
    const progress = road - startS, exit = predicted.speed,
      finite = [progress, exit, risk, finalGap, maxError, offtrack, rubbingDamage].every(Number.isFinite),
      trackable = finite && maxError <= Math.max(3, Math.abs(initial.e) + 0.75) && offtrack === 0 &&
        predicted.damage <= car.damage + 1e-8 && validForecast;
    if (rubbingDamage > (course.racecraft?.moveBudget ?? Infinity)) risk += 5;
    return { path, progress, exit, risk, threat, blocked, hardImpact, rubbingDamage,
      initialGap: target?.ds ?? 0, finalGap, relativeGain: (target?.ds ?? 0) - finalGap,
      exitAdvantage: rival ? exit - rival.v : 0, routeTax: path.timeTax ?? 0,
      cleared: clearSeconds >= 0.75, everCleared, clearSeconds, trackable, maxError, offtrack,
      horizon, plant: true, validForecast, score: finite ? progress + exit * 0.8 - risk * 5 : -Infinity };
  }
}
