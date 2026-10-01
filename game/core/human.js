import { clamp, damp, move } from '../engine/sim/math.js';

/**
 * Host-side driving filter for a human seat. Clients send raw axes
 * ({ dir, throttle, brake, reverse }); the host turns them into car controls
 * with the same speed-sensitive lock and counter-steer assist as the engine's
 * Keyboard (engine/sim/input.js), so local and network players drive alike.
 */
export class HumanFilter {
  constructor() { this.steer = 0; this.throttle = 0; this.brake = 0; }
  reset() { this.steer = this.throttle = this.brake = 0; }
  update(car, raw, dt, assisted = true) {
    const spec = car.spec, direction = clamp(raw.dir ?? 0, -1, 1);
    const speed = Math.max(3, car.speed);
    const gripBudget = 11.3 + car.aero.downforce / (spec.mass + car.fuel) * 0.8;
    const lock = assisted ? clamp(Math.atan(spec.wheelbase * gripBudget / (speed * speed)) / spec.steeringLock, 0.065, 1) : 1;
    const slip = Math.atan2(car.v, Math.max(5, car.u));
    const counter = assisted ? clamp(slip * 0.55 - car.yawRate * 0.06, -lock * 0.4, lock * 0.4) : 0;
    this.steer = move(this.steer, clamp(direction * lock + counter, -1, 1), dt * (direction ? 2.8 : 4.2));
    this.throttle = damp(this.throttle, clamp(raw.throttle ?? 0, 0, 1), 9, dt);
    this.brake = damp(this.brake, clamp(raw.brake ?? 0, 0, 1), 12, dt);
    return { throttle: this.throttle, brake: this.brake, steer: this.steer, reverse: Boolean(raw.reverse && car.u < 2) };
  }
}
