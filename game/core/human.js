import { clamp, damp, move } from '../engine/sim/math.js';

// Tuned against steady-state grip sweeps of each class in engine/sim.
const PEAK_SLIP = 0.15;   // front slip angle (rad) near peak lateral force
const YAW_GRIP = 1.25;    // yaw-rate target headroom over the grip estimate
const YAW_GAIN = 0.6;     // wheel rad per rad/s of yaw-rate error
const SLIDE_FREE = 0.12;  // body slip (rad) left alone before counter-steer
// Unassisted full-input wheel angle as a multiple of the zero-slip geometric angle.
const PEAK_STEER = { gt: 1.9, touring: 2.6, prototype: 1.3 };

/**
 * Host-side driving filter for a human seat. Clients send raw axes
 * ({ dir, throttle, brake, reverse }); the host turns them into car controls.
 *
 * Assisted: input asks for a yaw rate, full input being the grip limit at any
 * speed. Steering is feed-forward plus yaw-rate feedback, counter-steers once
 * body slip passes SLIDE_FREE, and never asks the front tyres for more than
 * PEAK_SLIP, so the nose neither scrubs nor needs a brake tap to rotate.
 *
 * Unassisted: plain wheel angle, with the range shrinking with speed so full
 * input is about the grip limit instead of 27 degrees at 200 km/h.
 * No counter-steer; slides are the driver's to catch.
 */
export class HumanFilter {
  constructor() { this.steer = 0; this.throttle = 0; this.brake = 0; }
  reset() { this.steer = this.throttle = this.brake = 0; }
  update(car, raw, dt, assisted = true) {
    const spec = car.spec, direction = clamp(raw.dir ?? 0, -1, 1);
    const u = Math.max(5, car.u), L = spec.wheelbase;
    const aeroGrip = car.aero.downforce / (spec.mass + car.fuel) * 0.8;
    let target;
    if (assisted) {
      const yawTarget = direction * YAW_GRIP * (11.3 * spec.tyreGrip + aeroGrip) / u;
      const beta = Math.atan2(car.v, u);
      target = L * yawTarget / u + YAW_GAIN * (yawTarget - car.yawRate) + beta - clamp(beta, -SLIDE_FREE, SLIDE_FREE);
      const frontPath = Math.atan2(car.v + car.yawRate * L * (1 - spec.frontWeight), u);
      target = clamp(target, frontPath - PEAK_SLIP, frontPath + PEAK_SLIP);
    } else {
      const speed = Math.max(3, car.speed);
      const peakSteer = (PEAK_STEER[spec.key] ?? 1.9) * Math.atan(L * (11.3 + aeroGrip) / (speed * speed));
      target = direction * Math.max(peakSteer, 0.01);
    }
    target = clamp(target / spec.steeringLock, -1, 1);
    this.steer = move(this.steer, target, dt * (assisted ? 6 : direction ? 2.8 : 4.2));
    this.throttle = damp(this.throttle, clamp(raw.throttle ?? 0, 0, 1), 9, dt);
    this.brake = damp(this.brake, clamp(raw.brake ?? 0, 0, 1), 12, dt);
    return { throttle: this.throttle, brake: this.brake, steer: this.steer, reverse: Boolean(raw.reverse && car.u < 2) };
  }
}
