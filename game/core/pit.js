import { clamp, wrap } from '../engine/sim/math.js';

const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

/**
 * Pit lane geometry in track coordinates. Built from `scenario.pit` when the
 * track defines one, otherwise laid alongside the start/finish straight.
 * Every position is a track distance `s` (metres) plus a lateral offset.
 */
export class PitLane {
  constructor(track, teamCount) {
    const L = track.length, pit = track.scenario?.pit;
    const half = track.halfWidth;
    if (pit) {
      this.entry = pit.entryFraction * L; this.limiter = pit.limiterFraction * L;
      this.boxStart = pit.boxStartFraction * L; this.boxEnd = pit.boxEndFraction * L;
      this.exit = pit.exitFraction * L; this.laneLat = pit.lateralM;
      this.limit = pit.pitSpeedLimitMps ?? 16.67; this.entryLimit = pit.entrySpeedLimitMps ?? 23.5;
    } else {
      const f = track.finishS;
      this.entry = wrap(f - 330, L); this.limiter = wrap(f - 270, L);
      this.boxStart = wrap(f - 220, L); this.boxEnd = wrap(f - 40, L);
      this.exit = wrap(f + 170, L); this.laneLat = -(half + track.curbWidth + 4.2);
      this.limit = 16.67; this.entryLimit = 23.5;
    }
    this.L = L; this.side = Math.sign(this.laneLat) || -1;
    this.edgeLat = this.side * (half - 1.6);
    this.rejoinLat = this.side * (half - 2.2);
    // Garage boxes sit in a working lane beside the fast lane, so cars being
    // serviced never block cars driving through.
    this.boxLat = this.laneLat + this.side * 4.6;
    // The driver keeps the car until just before entry; the autopilot only
    // peels to the pit edge and scrubs to the limiter over the final metres.
    // Harbor Ring's entry follows a quick kink with the line already pit-side; the
    // newer circuits need a longer, gentler peel across the track.
    // The lateral move itself happens over the last `cross` metres, after most of the speed is gone.
    const peel = track.id === 'harbor-ring' ? { m: 50, decel: 6, cross: 50 } : { m: 150, decel: 4, cross: 70 };
    this.approach = wrap(this.entry - peel.m, L); this.approachDecel = peel.decel; this.cross = peel.cross;
    // Speed to reach the entry at: Harbor's entry is tight, so its cars arrive on the limiter.
    this.entryV = track.id === 'harbor-ring' ? this.limit : this.entryLimit;
    this.handover = wrap(this.exit + 45, L);
    this.exitRamp = 70;
    const span = this.d(this.boxStart, this.boxEnd);
    this.boxes = Array.from({ length: teamCount }, (_, i) => wrap(this.boxStart + span * (i + 0.5) / teamCount, L));
    this.length = this.d(this.entry, this.exit);
    // Pit wall along the parallel section, just outside the kerb.
    const wallFrom = wrap(this.limiter + 8, L), wallTo = wrap(this.exit - this.exitRamp - 5, L);
    this.wall = { from: wallFrom, to: wallTo, lat: this.side * (half + track.curbWidth + .525), half: .175, has: (s) => this.inWindow(s, wallFrom, wallTo) };
    track.pitWall = this.wall;
    track.setPitLane([
      { from: this.entry, to: this.exit, halfWidth: 3.4, lateral: (s) => this.laneAt(s) },
      { from: wrap(this.boxStart - 30, L), to: wrap(this.boxEnd + 30, L), halfWidth: 3.2, lateral: () => this.boxLat }
    ]);
  }
  /** Forward distance from a to b along the lap. */
  d(a, b) { return wrap(b - a, this.L); }
  /** Pit corridor lateral at `s` (only meaningful between entry and exit). */
  laneAt(s) {
    const fromEntry = this.d(this.entry, s), toLim = this.d(this.entry, this.limiter);
    if (fromEntry <= toLim) return this.edgeLat + (this.laneLat - this.edgeLat) * smooth(fromEntry / toLim);
    const toExit = this.d(s, this.exit);
    if (toExit < this.exitRamp && fromEntry <= this.length) return this.rejoinLat + (this.laneLat - this.rejoinLat) * smooth(toExit / this.exitRamp);
    return this.laneLat;
  }
  inWindow(s, a, b) { return this.d(a, s) <= this.d(a, b); }
  inLane(s) { return this.inWindow(s, this.entry, this.exit); }
}

/**
 * Drives a car from the approach point through the lane, stops it in its box,
 * holds it for service and releases it back to the racing surface. Runs for AI
 * and human cars alike, so every stop obeys the same limiter and lane.
 */
export class PitAutopilot {
  constructor(lane, box, line) {
    this.lane = lane; this.box = box; this.line = line; this.phase = 'approach'; this.steer = 0; this.serviceLeft = 0;
  }
  targetLat(s) {
    const lane = this.lane;
    if (this.phase === 'approach') {
      // Stay on the racing line, then peel to the pit-side edge before entry.
      const toEntry = lane.d(s, lane.entry), peel = lane.cross;
      const lineLat = this.line.offsetAt(s);
      return toEntry > lane.d(lane.approach, lane.entry) ? lane.edgeLat : toEntry > peel ? lineLat : lineLat + (lane.edgeLat - lineLat) * smooth(1 - toEntry / peel);
    }
    if (this.phase === 'release' && !lane.inLane(s)) {
      const u = lane.d(lane.exit, s) / Math.max(1, lane.d(lane.exit, lane.handover));
      return lane.rejoinLat * (1 - smooth(u) * 0.4);
    }
    // Slide from the fast lane into the box over the last metres, and back out after service.
    const toBox = lane.d(s, this.box), past = lane.d(this.box, s);
    const u = this.phase === 'lane' ? (past < 40 ? 1 : smooth(1 - toBox / 16)) : (past < 200 ? 1 - smooth(past / 9) : 0);
    return lane.laneAt(s) + (lane.boxLat - lane.laneAt(s)) * u;
  }
  targetSpeed(s, car) {
    const lane = this.lane;
    if (this.phase === 'approach') return Math.min(this.cornerSpeed(s), this.pathSpeed(s), Math.sqrt(lane.entryV ** 2 + 2 * lane.approachDecel * lane.d(s, lane.entry)));
    if (this.phase === 'lane') {
      const toBox = lane.d(s, this.box);
      return Math.min(this.laneCurveSpeed(s), Math.sqrt(2 * 4.2 * Math.max(0, toBox - 0.4)));
    }
    if (this.phase === 'release') return lane.inLane(s) && !lane.inWindow(s, wrap(lane.exit - lane.exitRamp, lane.L), lane.exit) ? this.laneCurveSpeed(s) : 40;
    return 0;
  }
  /** Limiter speed, lowered where the lane (offset from the centreline) bends tighter than the tyres allow. */
  laneCurveSpeed(s) {
    let v = this.lane.limit;
    for (let d = 0; d <= 40; d += 5) {
      const k = Math.abs(this.track.at(s + d, 0).curvature), l = Math.abs(this.lane.laneAt(s + d));
      v = Math.min(v, Math.sqrt(9 * Math.max(1, 1 / k - l) + 2 * 4 * d));
    }
    return v;
  }
  /** Speed for the peel path itself: it cuts to the pit-side edge, often the inside of a bend. */
  pathSpeed(s) {
    let v = Infinity;
    for (let d = 0; d <= 150; d += 10) {
      const k = Math.abs(this.track.at(s + d, 0).curvature), r = k > 1e-4 ? 1 / k - Math.abs(this.targetLat(s + d)) : 1e4;
      v = Math.min(v, Math.sqrt(8 * Math.max(15, r) + 2 * 4 * d));
    }
    return v;
  }
  /** Racing-line speed with a braking envelope over the next 150 m. */
  cornerSpeed(s) {
    let v = Infinity;
    for (let d = 0; d <= 150; d += 10) v = Math.min(v, Math.sqrt(this.line.at(s + d).conservativeSpeed ** 2 + 2 * 7 * d));
    return v * 0.97;
  }
  /** Returns true once the car is back on track and can be handed over. */
  update(car, track, dt) {
    this.track = track;
    // Take over from the driver's current lock, so the hand-over doesn't jolt a car that is mid-corner.
    if (this.steer0 === undefined) { this.steer0 = true; this.steer = car.controls.steer ?? 0; }
    const p = track.nearest(car.x, car.z), s = p.s, lane = this.lane;
    if (this.phase === 'approach' && lane.inWindow(s, lane.entry, lane.boxStart)) this.phase = 'lane';
    if (this.phase === 'lane' && lane.d(s, this.box) < 0.9 && car.speed < 0.9) this.phase = 'service';
    if (this.phase === 'lane' && lane.d(this.box, s) < 30 && lane.d(this.box, s) > 0.9) this.phase = 'service'; // overshoot guard
    if (this.phase === 'service') { car.controls = { throttle: 0, brake: 1, steer: 0 }; return false; }
    if (this.phase === 'release' && lane.inWindow(s, lane.handover, wrap(lane.handover + 60, lane.L))) return true;
    const look = clamp(4 + car.speed * 0.6, 8, 24);
    const target = track.at(s + look, this.targetLat(s + look));
    const dx = target.x - car.x, dz = target.z - car.z;
    const lx = dx * Math.cos(car.yaw) - dz * Math.sin(car.yaw);
    const spec = car.spec;
    // Pure pursuit plus slip compensation (as the reference controller), with
    // the steer angle capped to a lateral-acceleration budget so a boxing car
    // never asks for more rotation than the tyres give at that speed.
    const slip = Math.atan2(car.v, Math.max(4, car.u));
    const budget = Math.atan(spec.wheelbase * (this.phase === 'approach' ? 15 : 12) / Math.max(1, car.speed * car.speed));
    const angleCmd = clamp(Math.atan2(2 * spec.wheelbase * lx, Math.max(12, dx * dx + dz * dz)), -budget, budget) + slip * 0.5;
    const steer = clamp(angleCmd / spec.steeringLock, -1, 1);
    this.steer += (steer - this.steer) * Math.min(1, dt * 10);
    const headingError = Math.abs(Math.atan2(Math.sin(p.heading - car.yaw), Math.cos(p.heading - car.yaw)));
    const error = this.targetSpeed(s, car) - car.speed;
    // Traction cap: gentle throttle at low speed, under steering load or when
    // pointing away from the lane, so the rear never breaks loose.
    const traction = clamp(0.3 + car.speed / 25, 0.3, 1) * (1 - 0.5 * Math.abs(this.steer)) * (headingError > 0.6 ? 0.5 : 1);
    // Friction circle: in a bend the tyres are already busy cornering, so the
    // approach brakes only with what grip is left.
    const latG = car.speed * car.speed * Math.abs(p.curvature ?? track.at(s, 0).curvature);
    const brakeCap = this.phase === 'approach' ? clamp(1 - latG / 12, 0.2, 1) : 1;
    car.controls = { steer: this.steer, throttle: clamp(error * 0.22, 0, traction), brake: clamp(-error * 0.16, 0, brakeCap) };
    return false;
  }
  release() { this.phase = 'release'; }
}
