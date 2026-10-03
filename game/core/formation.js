import { clamp } from '../engine/sim/math.js';

/**
 * Rolling start, iRacing-style. The field forms up two-wide `lead` metres
 * before the line, runs at pace speed under a formation autopilot, and the
 * green flag drops when the leader reaches the start zone. Drivers get the
 * wheel back for the last `handover` seconds so every controller (worker
 * seats included) already holds live controls at green.
 */
export const ROLLING = { lead: 900, row: 14, lane: 2.4, pace: 30, green: 110, handover: 1 };

/**
 * Where the field forms up: past the last slow corner before the line, so the
 * two-wide rows never have to concertina through a hairpin. Returns the
 * distance (m) from the pole slot to the line.
 */
export function rollingLead(track, cars) {
  const lastRow = Math.floor((cars - 1) / 2) * ROLLING.row, lane = Math.min(ROLLING.lane, track.halfWidth * 0.4);
  const min = ROLLING.green + 220;
  for (let d = min; d <= ROLLING.lead + lastRow; d += 10) {
    const k = Math.abs(track.at(track.finishS - d, 0).curvature), r = k > 1e-4 ? 1 / k - lane : 1e4;
    if (Math.sqrt(6 * r) < 22) return Math.max(min, d - 40 - lastRow);
  }
  return ROLLING.lead;
}

export class FormationPilot {
  constructor(race) {
    this.race = race; this.lead = rollingLead(race.track, race.cars.length); this.lane = Math.min(ROLLING.lane, race.track.halfWidth * 0.4);
    this.state = race.cars.map(() => ({ steer: 0, hold: 0.15 }));
    this.handedOver = false;
  }
  slot(i) { return { row: Math.floor(i / 2), lat: i % 2 ? -this.lane : this.lane }; }
  /** Metres the leader still has to run before the green. */
  toGreen() { return -ROLLING.green - this.race.cars[0].race.progress; }
  /** Pace speed at `s` on a lane: capped by the bend radius ahead and a gentle braking envelope. */
  capSpeed(s, lat) {
    const track = this.race.track; let v = ROLLING.pace;
    for (let d = 0; d <= 160; d += 10) {
      const k = Math.abs(track.at(s + d, 0).curvature), r = k > 1e-4 ? Math.max(12, 1 / k - Math.abs(lat)) : 1e4;
      v = Math.min(v, Math.sqrt(6 * r + 2 * 3.5 * d));
    }
    return v;
  }
  drive(i, c, dt) {
    const race = this.race, track = race.track, st = this.state[i], { row, lat } = this.slot(i);
    const p = track.nearest(c.x, c.z), s = p.s, lead = race.cars[0];
    let target = this.capSpeed(s, lat);
    if (i === 0) {
      // The leader backs off while the field is strung out, so it bunches up before the green.
      const last = race.cars.length - 1, spread = lead.race.progress - race.cars[last].race.progress - this.slot(last).row * ROLLING.row;
      target = Math.min(target, Math.max(12, ROLLING.pace - clamp((spread - 8) * 0.35, 0, 18)));
    } else {
      // Hold the slot behind the leader, never closer than 9 m to the car ahead in the same file.
      const err = (lead.race.progress - row * ROLLING.row) - c.race.progress;
      target = Math.min(target, Math.max(0, lead.speed + clamp(err * 0.5, -6, 10)));
      const file = race.cars[i - 2];
      if (file) { const gap = file.race.progress - c.race.progress; if (gap < 9) target = Math.min(target, file.speed - (9 - gap)); }
    }
    // Pure pursuit to the lane, as the pit autopilot.
    const look = clamp(4 + c.speed * 0.6, 8, 24), t = track.at(s + look, lat);
    const dx = t.x - c.x, dz = t.z - c.z, lx = dx * Math.cos(c.yaw) - dz * Math.sin(c.yaw);
    const budget = Math.atan(c.spec.wheelbase * 18 / Math.max(1, c.speed * c.speed));
    const angle = clamp(Math.atan2(2 * c.spec.wheelbase * lx, Math.max(12, dx * dx + dz * dz)), -budget, budget) + Math.atan2(c.v, Math.max(4, c.u)) * 0.5;
    st.steer += (clamp(angle / c.spec.steeringLock, -1, 1) - st.steer) * Math.min(1, dt * 10);
    // Speed hold: a slow integrator carries the cruise throttle, P on top.
    const error = target - c.speed;
    st.hold = clamp(st.hold + error * dt * 0.04, 0, 0.6);
    const traction = clamp(0.3 + c.speed / 25, 0.3, 1) * (1 - 0.5 * Math.abs(st.steer));
    c.automatic = true;
    c.controls = { steer: st.steer, throttle: error > -0.8 ? clamp(st.hold + error * 0.2, 0, traction) : 0, brake: error < -0.8 ? clamp(-error * 0.12, 0, 0.7) : 0 };
  }
  /** Returns true on the step the green flag drops. */
  step(dt, context) {
    const race = this.race, left = this.toGreen();
    if (!this.handedOver && left <= ROLLING.handover * race.cars[0].speed) {
      // Drivers take the wheel back: controllers are reset to the live state and start computing.
      this.handedOver = true;
      for (const e of race.entries) e.bridges[e.active].reset?.({ cars: race.cars, track: race.track, line: race.lineFor(e.car) });
    }
    race.entries.forEach((e, i) => {
      if (this.handedOver) e.bridges[e.active].update(e.car, race.cars, dt, context);
      this.drive(i, e.car, dt);
    });
    return left <= 0;
  }
}
