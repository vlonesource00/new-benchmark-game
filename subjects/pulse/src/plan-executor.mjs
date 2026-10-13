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

const SIDE_GAP = 2.7, SIDE_LENGTH = 5.5, SIDE_HORIZON = 100, SIDE_ACCEL = 6;

/** Execution only: no Battle, candidate search, attack/defence decisions or
 * expert actuation. A held spatial route receives fresh physics feedback.
 */
export class PlanExecutor {
  constructor(track, car, { frontalGuard = 'supervisor-v1', roadBounds = 'asphalt-body', edgeBlend = 0, edgeRamp = 0,
    routeOrigin = 'rolling-v1', feedback = 'escape-v1', joinState = 'body-v1', sideGuard = 'off', offsetLag = 0, offsetDeadband = 0, ...unsupported } = {}) {
    if (Object.keys(unsupported).length) throw Error('Unsupported plan execution option: ' + Object.keys(unsupported).join(', '));
    if (!['supervisor-v1', 'live-body-speed-v1', 'live-route-speed-v1'].includes(frontalGuard)) throw Error('Unknown experimental frontal guard');
    if (!['asphalt-body', 'kerb-centre', 'line-kerb-v1'].includes(roadBounds)) throw Error('Unknown experimental road bound');
    if (!Number.isFinite(edgeBlend) || edgeBlend < 0 || edgeBlend > 2) throw Error('Invalid experimental edge blend');
    if (!Number.isFinite(edgeRamp) || edgeRamp < 0 || edgeRamp > 80) throw Error('Invalid experimental edge ramp');
    if (!['rolling-v1', 'request-v1'].includes(routeOrigin)) throw Error('Unknown experimental route origin');
    if (!['escape-v1', 'course-v1'].includes(feedback)) throw Error('Unknown experimental route feedback');
    if (!['body-v1', 'reference-v1'].includes(joinState)) throw Error('Unknown experimental route join');
    if (!['off', 'clearance-v1'].includes(sideGuard)) throw Error('Unknown experimental side guard');
    if (!Number.isFinite(offsetLag) || offsetLag < 0 || offsetLag > 1) throw Error('Invalid experimental offset lag');
    this.sideGuard = sideGuard;
    // offsetLag (s): first-order low-pass on the committed lane offsets. The learned route's near knot jitters from
    // reply to reply (median 0.17 m, p90 1 m on straights); at 250 km/h each jump is a lane change in 0.4 s, so the
    // car weaves, the slide guard lifts and the hybrid (throttle > 0.8) never deploys. Speed is not filtered.
    this.offsetLag = offsetLag;
    // offsetDeadband (m): soft dead-band on the compiled offsets, o -> sign(o) max(0, |o| - band). Sub-metre requests
    // wobble between replies (+0.7/-0.4 m through a fast kink) and the route's curvature then swings about the racing
    // line's (-7.9 vs -5.1 /km), so the envelope brakes 250 -> 217 km/h where RAZOR stays flat. Below the band the car
    // keeps the racing line; deliberate moves still reach the route, shortened by the band.
    if (!Number.isFinite(offsetDeadband) || offsetDeadband < 0 || offsetDeadband > 2) throw Error('Invalid experimental offset dead-band');
    this.offsetDeadband = offsetDeadband;
    this.frontalGuard = frontalGuard; this.roadBounds = roadBounds; this.edgeBlend = edgeBlend; this.edgeRamp = edgeRamp; this.routeOrigin = routeOrigin;
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
    const goal = decodePlan(action);
    if (this.offsetLag > 0 && this.sequence > 0) {
      const a = 1 - Math.exp(-Math.max(0, at - this.at) / this.offsetLag);
      goal.offsets = goal.offsets.map((x, i) => this.goal.offsets[i] + a * (x - this.goal.offsets[i]));
    }
    this.goal = goal; this.sequence = sequence; this.at = at;
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
    // clearance-v1: wherever the route will be alongside a forecast rival body,
    // keep SIDE_GAP between centres on the side the plan already takes. It is a
    // moving lane bound, eased like the road edges; with no room it is dropped
    // and the frontal guard governs.
    const track = this.course.track, sideRivals = this.sideGuard === 'clearance-v1'
      ? this.observer.list.filter(r => Math.abs(r.ds) < 90 && r.car !== car) : [], mySpeed = Math.max(5, car.speed);
    let sideStations = 0;
    const shift = new Float64Array(n + 1), corrections = new Float64Array(n + 1), along = new Float64Array(n + 1); let segment = 0, travelled = 0, clippedStations = 0, maxEdgeCorrection = 0;
    for (let j = 0; j <= n; j++) {
      const x = travelled - start;
      while (segment < points.length - 2 && x > distances[segment + 1]) segment++;
      const a = points[segment], b = points[segment + 1];
      let offset = x < 0 ? joinOffset + slope * x + .5 * curvature * x * x
        : quintic(a, b, b.distance - a.distance, x - a.distance);
      const i = base.idx(i0 + j), h = base.h[i], q = this.course.track.nearest(base.px[i] + Math.cos(h) * offset, base.pz[i] - Math.sin(h) * offset),
        asphalt = this.course.track.halfWidth - 1.12, kerb = this.course.track.halfWidth + (this.course.track.curbWidth ?? 0) - .15,
        // line-kerb-v1: kerb grip is 0.88 and bumpy, while the speed envelope
        // assumes asphalt. Only use as much kerb as the reference line already
        // uses at this station; an offset never pushes wider onto it.
        upper = this.roadBounds === 'kerb-centre' ? kerb : this.roadBounds === 'line-kerb-v1' ? clamp(base.lat[i], asphalt, kerb) : asphalt,
        lower = this.roadBounds === 'kerb-centre' ? kerb : this.roadBounds === 'line-kerb-v1' ? clamp(-base.lat[i], asphalt, kerb) : asphalt,
        projection = Math.max(.3, Math.cos(angle(h - this.course.track.at(q.s).heading))),
        bounded = smoothUpper(-smoothUpper(-q.lateral, lower, this.edgeBlend), upper, this.edgeBlend),
        side = sideRivals.length && x >= 0 && x <= SIDE_HORIZON ? this.sideBound(sideRivals, q, x / mySpeed, upper, lower, track) : null,
        boundedSide = side ? smoothUpper(-smoothUpper(-bounded, side.lower, this.edgeBlend), side.upper, this.edgeBlend) : bounded,
        // Side escapes are limited to what a SIDE_ACCEL lateral manoeuvre reaches by
        // this station (bang-bang: a t^2 / 4): at 68 m/s ~0.8 m over 50 m, never a step.
        sideReach = .3 + SIDE_ACCEL * (Math.max(0, x) / mySpeed) ** 2 / 4,
        correction = (q.lateral - bounded) / projection + clamp((bounded - boundedSide) / projection, -sideReach, sideReach);
      if (side) sideStations++;
      if (Math.abs(correction) > .001) clippedStations++;
      maxEdgeCorrection = Math.max(maxEdgeCorrection, Math.abs(correction));
      shift[j] = offset; corrections[j] = correction; along[j] = x;
      travelled += base.len[i];
    }
    // A pointwise clip leaves a curvature kink that the speed envelope reads as
    // a corner (0.5 m clip -> k 16e-3 vs 6e-3, 69 -> 35 m/s). edgeRamp eases
    // into each clip with a raised-cosine dilation: never nearer the edge than
    // the raw clip, and tapered from the join so the car's own position holds.
    // Each edge is eased separately so an S-bend's opposite clips never mask each other.
    const outer = corrections.map(c => Math.max(0, c)), inner = corrections.map(c => Math.min(0, c));
    if (this.edgeRamp > 0) for (let j = 0; j <= n; j++) for (let m = 0; m <= n; m++) {
      const c = corrections[m], d = Math.abs(along[j] - along[m]);
      if (!c || d >= this.edgeRamp) continue;
      const eased = c * (.5 + .5 * Math.cos(Math.PI * d / this.edgeRamp)) * clamp(along[j] / this.edgeRamp, 0, 1);
      if (c > 0) outer[j] = Math.max(outer[j], eased); else inner[j] = Math.min(inner[j], eased);
    }
    for (let j = 0; j <= n; j++) shift[j] -= outer[j] + inner[j];
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
      joinState: this.joinState, edgeRamp: this.edgeRamp, referenceJoin, joinOffset, bodyOffset: cur.e,
      consumed, remainingDistances: distances.slice(1), clippedStations, maxEdgeCorrection, floor, sideStations };
  }
  sideBound(rivals, q, t, upper, lower, track) {
    let up = upper, low = lower, hit = false;
    for (const r of rivals) {
      const p = this.observer.at(r, t), g = ((p.s - q.s) % track.length + 1.5 * track.length) % track.length - .5 * track.length;
      if (Math.abs(g) > SIDE_LENGTH || Math.abs(p.d - q.lateral) > SIDE_GAP + 2) continue;
      const side = Math.abs(q.lateral - p.d) > .2 ? Math.sign(q.lateral - p.d) : (upper - p.d > p.d + lower ? 1 : -1);
      if (side > 0) low = Math.min(low, -(p.d + SIDE_GAP)); else up = Math.min(up, p.d - SIDE_GAP);
      hit = true;
    }
    // No lane between the bounds: leave the route to the frontal guard.
    return hit && up >= -low + .2 ? { upper: up, lower: low } : null;
  }
  step(car, cars, dt, { time = 0, state = {} } = {}) {
    this.course.tick(car, dt); this.observer.update(car, cars, state, time);
    const line = this.course.line, cur = line.closest(car.x, car.z), age = Math.max(0, time - this.at),
      offsets = this.offsetDeadband ? this.goal.offsets.map(x => Math.sign(x) * Math.max(0, Math.abs(x) - this.offsetDeadband)) : this.goal.offsets;
    const changed = offsets.some((x, i) => Math.abs(x - this.compiledOffsets[i]) > .18);
    const elapsed = time - this.compiledAt, renew = this.path !== line && elapsed > .25 && age < .1;
    // A car near and within reach laterally keeps the side bound fresh at 10 Hz.
    const sideNear = this.sideGuard === 'clearance-v1' && this.observer.list.some(r => r.car !== car
      && r.ds > -SIDE_LENGTH && r.ds < Math.max(25, 2.5 * (car.speed - r.v) + 10) && Math.abs(r.d - car.lateral) < SIDE_GAP + 2.5);
    if ((changed || renew || sideNear && elapsed >= .1) && elapsed >= .05) {
      const started = performance.now();
      if (!sideNear && offsets.every(x => Math.abs(x) < .12) && Math.abs(cur.e) < .3) { this.path = line; this.compileTrace = null; }
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
    // live-route-speed-v1 also hands the guard the route being executed and our cursor on it, so a braking or stopped
    // car around a bend (outside the straight body ray) caps speed early, as INTERCEPT's controller does.
    let routeCursor = null;
    if (this.frontalGuard === 'live-route-speed-v1') {
      routeCursor = path.closest(car.x, car.z, path === this.controller.path ? this.controller.cursor : -1);
      if (routeCursor.d2 > 225) routeCursor = path.closest(car.x, car.z, -1);
    }
    const nose = this.frontalGuard === 'live-body-speed-v1' || this.frontalGuard === 'live-route-speed-v1'
      ? noseConstraint(car, this.observer, this.course.model, { lateralEscape: true, path: routeCursor ? path : null, cursor: routeCursor })
      : { cap: Infinity, brake: 0, blocker: null };
    const lateralDemand = Math.abs(offsets[0] - cur.e);
    const courseFeedback = this.feedback === 'course-v1';
    this.controller.options = courseFeedback && this.path !== line ? this.feedbackOptions : this.options;
    const controls = this.controller.step(car, path, this.course, this.observer, dt, { time, nose });
    const cursor = this.controller.cur, selectedRoute = Array.from({ length: 20 }, (_, i) => ({
      x: path.sample(path.px, cursor.i, cursor.f, i * 9), z: path.sample(path.pz, cursor.i, cursor.f, i * 9),
      speed: path.sample(path.vbrk, cursor.i, cursor.f, i * 9) }));
    this.trace = { contract: PLAN_CONTRACT.version, frontalGuard: this.frontalGuard, sideGuard: this.sideGuard, routeOrigin: this.routeOrigin, feedback: this.feedback,
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
