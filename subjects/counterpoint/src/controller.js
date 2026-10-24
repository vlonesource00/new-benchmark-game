import { Controller, noseConstraint, controlMemory } from '../../vanguard-v2/src/controller.js';
import { axleState } from '../../vanguard-v2/src/axles.js';
import { bodyContact } from '../../vanguard-v2/src/body.js';
import { angle, advance } from '../../vanguard-v2/src/math.js';

/** Leave lateral capacity for correcting a growing tracking error. A fast
 * profile is useful only while the car can actually follow its geometry. */
export function needsTrackingCoast(car, path, cursor, axles) {
  const v = car.speed, error = Math.abs(cursor.e),
    psi = angle(car.yaw + axles.beta - path.heading(cursor.i, cursor.f)),
    outward = Math.sign(cursor.e) * Math.sin(psi) * v;
  return v >= 12 && error > .8 && outward > .4 && axles.use >= .75;
}

/** Preserve closing speed only behind a demonstrated, trackable escape route.
 * This changes the frontal guard, not observations, contact physics or limits. */
export function routeClears(car, rival, path, cursor, course, observer, reserve) {
  if (!path.attackSide || path === course.line || Math.abs(cursor.e) > .4 || reserve < .85 ||
      !rival.eligible || rival.pit || rival.hazard || (rival.car.controls?.brake ?? 0) > .05 ||
      (rival.ax ?? 0) < -2 || Math.abs(angle(car.yaw - path.heading(cursor.i, cursor.f))) > .09) return false;
  const closing = car.speed - rival.v, room = rival.ds - 2.28 - rival.along;
  if (closing < .7 || closing > 8 || room < 3 || rival.ds > 45) return false;
  const model = course.model, mass = (car.spec?.mass ?? 1300) + (car.fuel ?? 50) * .75,
    // Removing a speed cap can immediately invite full throttle. Check that
    // case as well as held speed, including tow and an acceleration margin.
    acceleration = Math.max(.5, model.drive(car.speed, mass) + model.towGain(car.speed, car.aero?.wake ?? 0) + .5),
    impact = (Math.sqrt(closing * closing + 2 * acceleration * room) - closing) / acceleration,
    delay = (path.anchorDelay ?? 0) + .15,
    deadline = Math.min(1.1, impact - delay);
  if (deadline < .25) return false;
  let clearAt = null;
  for (let t = .1; t <= deadline + 1e-8; t += .05) {
    let bothClear = true;
    for (const a of [0, acceleration]) {
    const speed = car.speed + a * t,
      c = advance(path, cursor.i, cursor.f, car.speed * t + .5 * a * t * t), h = path.heading(c.i, c.f),
      x = path.sample(path.px, c.i, c.f), z = path.sample(path.pz, c.i, c.f), road = course.track.nearest(x, z),
      body = { x, z, h, vx: Math.sin(h) * speed, vz: Math.cos(h) * speed }, predicted = observer.at(rival, t);
    if (Math.abs(road.lateral) > course.track.halfWidth - 1.08 || predicted.valid === false) return false;
    if (bodyContact(body, predicted, .22)) return false;
    const dx = predicted.x - x, dz = predicted.z - z,
      across = Math.abs(dx * Math.cos(h) - dz * Math.sin(h)),
      rotation = angle(predicted.h - h),
      needed = .98 + .98 * Math.abs(Math.cos(rotation)) + 2.28 * Math.abs(Math.sin(rotation)) + .22;
    bothClear &&= across > needed;
    }
    if (bothClear) clearAt ??= t;
    else clearAt = null;
  }
  return clearAt !== null && deadline - clearAt >= .15;
}

export class CounterpointController extends Controller {
  sideCorrection(car, rival, course, observer, geometry) {
    // The shared contact policy has already checked alignment, closing speed,
    // overlap and the remaining race/move damage budget. Hold owned space in
    // that envelope instead of simultaneously ordering an evasive steer.
    if (this.options.contestSpace !== false && geometry.hold && !geometry.returning &&
        Math.abs(observer.me.d) < course.track.halfWidth - 1.1 &&
        Math.abs(rival.d) < course.track.halfWidth - 1.1) {
      (this.contestedHolds ??= []).push(rival.id);
      return 0;
    }
    return super.sideCorrection(car, rival, course, observer, geometry);
  }

  step(car, path, course, observer, dt, context = {}) {
    this.contestedHolds = [];
    const canEscape = this.options.routeEscape !== false && !context.returning && !Number.isFinite(context.pit);
    if (!canEscape && this.options.coastRecovery !== true) {
      const controls = super.step(car, path, course, observer, dt, context);
      this.trace.contestedHolds = this.contestedHolds;
      return controls;
    }
    const cursor = path.closest(car.x, car.z, path === this.path ? this.cursor : -1),
      v = Math.max(.5, car.speed), ax = axleState(car, course.model, path.sample(path.ks, cursor.i, cursor.f, v * this.options.preview)),
      parameters = { path, cursor, brakingTube: context.brakingTube ?? this.options.brakingTube, racecraft: course.racecraft,
        adaptiveAttacks: this.options.adaptiveAttacks === true && course.racecraft?.enabled,
        brakingHeadway: this.options.brakingHeadway ?? 0,
        brakingSoon: path.sample(path.vbrk, cursor.i, cursor.f, Math.max(25, v * .65)) < v + 2,
        lateralEscape: this.options.noseEscape && path !== course.line && path.attackSide && Math.abs(cursor.e) < .65 && ax.reserve > .75 };
    let nose = context.nose ?? noseConstraint(car, observer, course.model, parameters);
    const certified = [];
    // Each removed constraint has a body-sweep witness. Keep all other rivals
    // in the guard and all rivals in the controller's original observation.
    for (let n = 0; canEscape && n < 2 && nose.blocker; n++) {
      if (!routeClears(car, nose.blocker, path, cursor, course, observer, ax.reserve)) break;
      certified.push(nose.blocker.id);
      const view = { ...observer, list: observer.list.filter(r => !certified.includes(r.id)), at: observer.at.bind(observer) };
      nose = noseConstraint(car, view, course.model, parameters);
    }
    const controls = super.step(car, path, course, observer, dt, { ...context, nose });
    const paceRoute = path === course.line || path.key === 'course',
      clearAir = !observer.list.some(r => r.physical && !r.pit && r.ds > -15 && r.ds < 60),
      coast = this.options.coastRecovery === true && paceRoute && !context.returning && clearAir &&
        needsTrackingCoast(car, path, cursor, ax);
    if (coast && controls.throttle > 0) {
      // Do not add trail braking to an unstable rear axle. Remove drive only;
      // retain the existing brakes and update the published control memory.
      const drag = course.model.dragK * v * v + .13;
      this.trace.allocatedAcceleration -= controls.throttle * (course.model.drive(v) + drag);
      controls.throttle = 0;
      this.acceleration = Math.min(this.acceleration, this.trace.allocatedAcceleration);
      const memory = controlMemory(car);
      if (memory) memory.acceleration = this.acceleration;
      Object.assign(this.trace, { source: 'tracking-coast', pedal: 'tracking-coast', pedalReason: 'tracking-coast',
        throttle: 0, acceleration: this.acceleration });
    }
    this.trace.trackingCoast = coast;
    this.trace.routeEscape = certified;
    this.trace.routeEscapeCount = certified.length;
    this.trace.contestedHolds = this.contestedHolds;
    return controls;
  }
}
