import { Course } from '../../intercept/src/course.js';
import { Controller, noseConstraint } from '../../intercept/src/controller.js';
import { Observer } from '../../intercept/src/observer.js';
import { settingsFor } from '../../intercept/src/settings.js';
import { decodePlan, PLAN_CONTRACT } from './plan-contract.mjs';
import { clamp, angle } from '../../intercept/src/math.js';
import { CourseArc } from './course-arc.mjs';

/** Join preserving position, slope and curvature at BOTH endpoints. */
export function quintic(a, b, length, distance) {
  const u = clamp(distance / length, 0, 1), a1 = a.slope * length, a2 = .5 * a.curvature * length * length;
  const A = b.offset - a.offset - a1 - a2, B = b.slope * length - a1 - 2 * a2,
    C = b.curvature * length * length - 2 * a2;
  return a.offset + u * (a1 + u * (a2 + u * (10 * A - 4 * B + .5 * C
    + u * (-15 * A + 7 * B - C + u * (6 * A - 3 * B + .5 * C)))));
}

// C2 saturation: an edge constraint must not insert a heading discontinuity
// into an otherwise achievable route. Exact outside the short blend interval.
export function smoothUpper(value, upper, width) {
  if (!(width > 0)) return Math.min(value, upper);
  const d = upper - value;
  if (d >= width) return value;
  if (d <= -width) return upper;
  const t = (d + width) / (2 * width);
  return upper - 2 * width * (t * t * t - .5 * t * t * t * t);
}

/** Execution only: no Battle, candidate search, attack/defence decisions or
 * expert actuation. A held spatial route receives fresh physics feedback.
 */
export class PlanExecutor {
  constructor(track, car, { frontalGuard = 'supervisor-v1', roadBounds = 'asphalt-body', edgeBlend = 0,
    routeOrigin = 'rolling-v1', feedback = 'escape-v1', joinState = 'body-v1', ...unsupported } = {}) {
    if (Object.keys(unsupported).length) throw Error('Unsupported plan execution option: ' + Object.keys(unsupported).join(', '));
    if (!['supervisor-v1', 'live-body-speed-v1'].includes(frontalGuard)) throw Error('Unknown experimental frontal guard');
    if (!['asphalt-body', 'kerb-centre'].includes(roadBounds)) throw Error('Unknown experimental road bound');
    if (!Number.isFinite(edgeBlend) || edgeBlend < 0 || edgeBlend > 2) throw Error('Invalid experimental edge blend');
    if (!['rolling-v1', 'request-v1'].includes(routeOrigin)) throw Error('Unknown experimental route origin');
    if (!['escape-v1', 'course-v1'].includes(feedback)) throw Error('Unknown experimental route feedback');
    if (!['body-v1', 'reference-v1'].includes(joinState)) throw Error('Unknown experimental route join');
    this.frontalGuard = frontalGuard; this.roadBounds = roadBounds; this.edgeBlend = edgeBlend; this.routeOrigin = routeOrigin;
    this.feedback = feedback; this.joinState = joinState;
    const config = settingsFor(track.id);
    this.options = { ...config, ...config.perClass?.[car.classId] };
    this.course = new Course(track, this.options); this.course.prepare(car);
    this.arc = new CourseArc(this.course.line); this.requests = new Map(); this.origin = null;
    this.observer = new Observer(track); this.observer.reference = this.course.line;
    this.controller = new Controller(this.options);
    // A lateral jerk allowance is not an instruction to use escape yaw/slip
    // gains on every corner. Keep the same 180 m/s^3 curvature response bound,
    // but retain ordinary class-specific feedback for a continuous learned route.
    this.feedbackOptions = { ...this.options, steerJerk: PLAN_CONTRACT.steerJerk };
    this.path = this.course.line; this.sequence = 0; this.at = 0;
    this.goal = { offsets: [0, 0, 0], speed: 95 }; this.compiledOffsets = [0, 0, 0];
    this.compiledAt = -Infinity; this.compiles = 0; this.compileMs = [];
    this.lanes = [this.course.line.blankLane(), this.course.line.blankLane()];
    for (const path of this.lanes) path.st = this.course.line.st.slice();
    this.slot = 0; this.profile = null; this.profileSource = null; this.trace = {}; this.compileTrace = null;
    this.epoch = 1;
  }
  reset() {
    // Recovery/seat reset also resets mailbox sequence numbers. Discard the
    // previous body's route and origin rather than rejecting the new epoch.
    this.path = this.course.line; this.sequence = 0; this.at = 0; this.epoch++;
    this.goal = { offsets: [0, 0, 0], speed: 95 }; this.compiledOffsets = [0, 0, 0];
    this.compiledAt = -Infinity; this.origin = null; this.requests.clear();
    this.lanes = [this.course.line.blankLane(), this.course.line.blankLane()];
    for (const path of this.lanes) path.st = this.course.line.st.slice();
    this.slot = 0; this.profile = null; this.profileSource = null; this.trace = {}; this.compileTrace = null;
    this.controller.reset(); this.course.clock = 99;
  }
  // The route belongs to the observation that produced it. A delayed reply
  // must not silently move its waypoints forward to the receiving pose.
  request(sequence, at, car) {
    if (!Number.isInteger(sequence) || sequence <= 0 || !Number.isFinite(at)) throw Error('Invalid plan request origin');
    this.requests.set(sequence, { at, arc: this.arc.project(car.x, car.z).arc });
    for (const [seq, origin] of this.requests) if (origin.at < at - 1) this.requests.delete(seq);
  }
  commit(action, sequence, at) {
    if (!Number.isInteger(sequence) || sequence < this.sequence || !Number.isFinite(at)) throw Error('Invalid plan sequence');
    if (sequence === this.sequence) return;
    const origin = this.requests.get(sequence);
    if (this.routeOrigin === 'request-v1' && (!origin || Math.abs(origin.at - at) > 1e-9))
      throw Error('Accepted plan has no matching observation origin');
    this.goal = decodePlan(action); this.sequence = sequence; this.at = at;
    this.origin = origin ?? null;
    for (const seq of this.requests.keys()) if (seq <= sequence) this.requests.delete(seq);
  }
  compile(car, cur, offsets) {
    const base = this.course.line, i0 = cur.i, start = cur.f * base.len[i0],
      beta = Math.atan2(car.v, Math.max(2, car.u));
    let joinOffset = cur.e, slope = clamp(Math.tan(angle(car.yaw + beta - base.heading(cur.i, cur.f))), -.35, .35),
      // Body yaw is not trajectory curvature during slip. Project measured
      // acceleration perpendicular to the velocity direction instead.
      velocityCurvature = ((car.ay ?? 0) * Math.cos(beta) - (car.ax ?? 0) * Math.sin(beta)) / Math.max(64, car.speed * car.speed),
      curvature = clamp(velocityCurvature - base.ks[i0], -.006, .006);
    const referenceJoin = this.joinState === 'reference-v1' && Number.isFinite(this.compiledAt);
    if (referenceJoin) {
      const next = base.idx(i0 + 1), f = cur.f, h = base.heading(i0, f),
        dx = (this.path.px[i0] - base.px[i0]) * (1 - f) + (this.path.px[next] - base.px[next]) * f,
        dz = (this.path.pz[i0] - base.pz[i0]) * (1 - f) + (this.path.pz[next] - base.pz[next]) * f;
      joinOffset = dx * Math.cos(h) - dz * Math.sin(h);
      slope = clamp(Math.tan(angle(this.path.heading(i0, f) - h)), -.35, .35);
      curvature = clamp(this.path.ks[i0] * (1 - f) + this.path.ks[next] * f
        - base.ks[i0] * (1 - f) - base.ks[next] * f, -.006, .006);
    }
    const consumed = this.routeOrigin === 'request-v1' && this.origin
      ? Math.max(0, this.arc.delta(this.arc.starts[i0] + start, this.origin.arc)) : 0;
    const remaining = PLAN_CONTRACT.distances.map((distance, i) => ({ distance: distance - consumed, offset: offsets[i] }))
      .filter(point => point.distance > 6);
    const values = [joinOffset, ...remaining.map(p => p.offset), 0],
      distances = [0, ...remaining.map(p => p.distance), Math.max(20, PLAN_CONTRACT.rejoinMetres - consumed)];
    const points = values.map((offset, i) => ({ offset, slope: 0, curvature: 0, distance: distances[i] }));
    points[0].slope = slope; points[0].curvature = curvature;
    for (let i = 1; i < points.length - 1; i++) {
      const before = (values[i] - values[i - 1]) / (distances[i] - distances[i - 1]),
        after = (values[i + 1] - values[i]) / (distances[i + 1] - distances[i]);
      points[i].slope = before * after > 0 ? clamp(2 * before * after / (before + after), -.25, .25) : 0;
      points[i].curvature = clamp(2 * (after - before) / (distances[i + 1] - distances[i - 1]), -.008, .008);
    }
    const n = Math.min(base.N - 22, Math.ceil((distances.at(-1) + start) / base.ds));
    const shift = new Float64Array(n + 1); let segment = 0, travelled = 0, clippedStations = 0, maxEdgeCorrection = 0;
    for (let j = 0; j <= n; j++) {
      const x = travelled - start;
      while (segment < points.length - 2 && x > distances[segment + 1]) segment++;
      const a = points[segment], b = points[segment + 1];
      let offset = x < 0 ? joinOffset + slope * x + .5 * curvature * x * x
        : quintic(a, b, b.distance - a.distance, x - a.distance);
      const i = base.idx(i0 + j), h = base.h[i], q = this.course.track.nearest(base.px[i] + Math.cos(h) * offset, base.pz[i] - Math.sin(h) * offset),
        bound = this.roadBounds === 'kerb-centre' ? this.course.track.halfWidth + (this.course.track.curbWidth ?? 0) - .15
          : this.course.track.halfWidth - 1.12,
        projection = Math.max(.3, Math.cos(angle(h - this.course.track.at(q.s).heading))),
        bounded = smoothUpper(-smoothUpper(-q.lateral, bound, this.edgeBlend), bound, this.edgeBlend),
        correction = (q.lateral - bounded) / projection;
      if (Math.abs(correction) > .001) clippedStations++;
      maxEdgeCorrection = Math.max(maxEdgeCorrection, Math.abs(correction)); offset -= correction;
      shift[j] = offset;
      travelled += base.len[i];
    }
    const path = this.lanes[this.slot]; this.slot = 1 - this.slot;
    if (path.window) for (const key of ['px', 'pz', 'len', 'h', 'k', 'ks', 'dk', 'lat', 'vmax', 'v', 'vbrk', 'st'])
      for (let j = -14; j <= path.window.n + 16; j++) { const i = base.idx(path.window.i0 + j); path[key][i] = base[key][i]; }
    base.laneWindow(shift, i0, n, path);
    // laneWindow's default flat rear extension creates a false kink whenever
    // a fresh route starts with lateral velocity. Preserve the body's incoming
    // derivatives behind the join before building the braking envelope.
    let behind = -start;
    for (let j = 1; j <= 10; j++) {
      const i = base.idx(i0 - j); behind -= base.len[i];
      const offset = joinOffset + slope * behind + .5 * curvature * behind * behind, h = base.h[i];
      path.px[i] = base.px[i] + Math.cos(h) * offset; path.pz[i] = base.pz[i] - Math.sin(h) * offset;
      path.lat[i] = base.lat[i] + offset;
    }
    path.geometryRange(i0 - 12, n + 14);
    for (let j = -8; j <= n; j++) { const i = base.idx(i0 + j), q = this.course.track.nearest(path.px[i], path.pz[i]); path.st[i] = q.s; path.lat[i] = q.lateral; }
    // Build curvature/grip and braking limits for this exact compiled route.
    path.speedsWindow(this.course.model, i0, n, 95, base.vbrk[base.idx(i0 + n)],
      { mass: car.spec.mass + car.fuel * .75, brakeExp: this.options.brakeExp, jerk: 0, notch: false });
    path.steerJerk = PLAN_CONTRACT.steerJerk; path.key = 'learned-route'; this.path = path; this.profileSource = null;
    let floor = null;
    for (let j = 0; j <= n; j++) {
      const i = base.idx(i0 + j);
      if (!floor || path.vmax[i] < floor.speed) floor = { station: i, roadS: path.st[i], speed: path.vmax[i],
        baseSpeed: base.vmax[i], curvature: path.ks[i], baseCurvature: base.ks[i], lateral: path.lat[i] };
    }
    this.compileTrace = { roadBounds: this.roadBounds, edgeBlend: this.edgeBlend, routeOrigin: this.routeOrigin,
      joinState: this.joinState, referenceJoin, joinOffset, bodyOffset: cur.e,
      consumed, remainingDistances: distances.slice(1), clippedStations, maxEdgeCorrection, floor };
  }
  step(car, cars, dt, { time = 0, state = {} } = {}) {
    this.course.tick(car, dt); this.observer.update(car, cars, state, time);
    const line = this.course.line, cur = line.closest(car.x, car.z), age = Math.max(0, time - this.at), offsets = this.goal.offsets;
    const changed = offsets.some((x, i) => Math.abs(x - this.compiledOffsets[i]) > .18);
    const elapsed = time - this.compiledAt, renew = this.path !== line && elapsed > .25 && age < .1;
    if ((changed || renew) && elapsed >= .05) {
      const started = performance.now();
      if (offsets.every(x => Math.abs(x) < .12) && Math.abs(cur.e) < .3) { this.path = line; this.compileTrace = null; }
      else this.compile(car, cur, offsets);
      this.compiledOffsets = [...offsets]; this.compiledAt = time; this.compiles++;
      this.compileMs.push(performance.now() - started);
    }
    let path = this.path;
    const speed = this.goal.speed;
    if (speed < PLAN_CONTRACT.speedCeiling - .1) {
      if (this.profileSource !== path) {
        this.profile = Object.create(path); this.profile.vbrk = path.vbrk.slice(); this.profile.vmax = path.vmax.slice(); this.profileSource = path;
      }
      for (let i = 0; i < path.N; i++) {
        this.profile.vbrk[i] = Math.min(path.vbrk[i], speed); this.profile.vmax[i] = Math.min(path.vmax[i], speed);
      }
      path = this.profile;
    }
    const nose = this.frontalGuard === 'live-body-speed-v1'
      ? noseConstraint(car, this.observer, this.course.model, { lateralEscape: true }) : { cap: Infinity, brake: 0, blocker: null };
    const lateralDemand = Math.abs(offsets[0] - cur.e);
    const courseFeedback = this.feedback === 'course-v1';
    this.controller.options = courseFeedback && this.path !== line ? this.feedbackOptions : this.options;
    const controls = this.controller.step(car, path, this.course, this.observer, dt, { time, nose });
    const cursor = this.controller.cur, selectedRoute = Array.from({ length: 20 }, (_, i) => ({
      x: path.sample(path.px, cursor.i, cursor.f, i * 9), z: path.sample(path.pz, cursor.i, cursor.f, i * 9),
      speed: path.sample(path.vbrk, cursor.i, cursor.f, i * 9) }));
    this.trace = { contract: PLAN_CONTRACT.version, frontalGuard: this.frontalGuard, routeOrigin: this.routeOrigin, feedback: this.feedback,
      joinState: this.joinState,
      epoch: this.epoch,
      origin: this.origin, sequence: this.sequence, age,
      lateralDemand, activeFeedback: this.path === line ? 'course' : courseFeedback ? 'course' : 'escape',
      requestedOffsets: offsets, compiledOffsets: this.compiledOffsets, requestedSpeed: speed,
      routeKey: this.path.key ?? 'course', compiles: this.compiles, compiler: this.compileTrace,
      compiledAge: Number.isFinite(this.compiledAt) ? time - this.compiledAt : null, selectedRoute, ...this.controller.trace };
    return controls;
  }
}
