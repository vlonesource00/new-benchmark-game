// One source of truth for exhaust pops and bangs. Every car's throttle, gear
// and rpm are watched each frame; the resulting events drive the flames on the
// car model, the sparks/smoke/flash in the effects and the backfire audio, so
// what you see and what you hear always happen on the same frame.
//
// Event kinds:
//   shift  – upshift ignition cut, a sharp single crack
//   bang   – hard lift-off from high revs, the big one; starts a crackle train
//   crackle – small pops: downshift blips, crackle trains and random overrun
const LIFT_COOLDOWN = 0.35;

export class ExhaustEvents {
  constructor() { this.state = new Map(); this.time = 0; }

  reset() { this.state.clear(); }

  /** Returns this frame's events: [{ car, kind, strength }]. */
  update(cars, dt) {
    const out = [];
    if (dt <= 0) return out;
    this.time += dt;
    const t = this.time;
    for (const car of cars) {
      const thr = car.controls?.throttle ?? 0, rpm = car.rpm ?? 0;
      let s = this.state.get(car.id);
      if (!s) { s = { thr, gear: car.gear, lift: -1, train: 0, next: 0 }; this.state.set(car.id, s); }
      const moving = car.speed > 8;
      if (moving) {
        if (car.gear > s.gear) out.push({ car, kind: 'shift', strength: 0.45 + thr * 0.4 + Math.random() * 0.15 });
        else if (car.gear < s.gear && rpm > 3500) this.train(s, t, 2 + Math.floor(Math.random() * 3), 0.03);
        if (s.thr > 0.65 && thr < 0.2 && rpm > 4800 && t - s.lift > LIFT_COOLDOWN) {
          s.lift = t;
          out.push({ car, kind: 'bang', strength: 0.75 + Math.random() * 0.25 });
          this.train(s, t, 4 + Math.floor(Math.random() * 5), 0.07);
        }
        // Overrun: off throttle at high revs the engine keeps spitting.
        if (thr < 0.1 && rpm > 4500 && Math.random() < dt * 5 * ((rpm - 4500) / 3800)) {
          out.push({ car, kind: 'crackle', strength: 0.28 + Math.random() * 0.3 });
        }
        if (s.train > 0 && t >= s.next) {
          s.train -= 1; s.next = t + 0.045 + Math.random() * 0.075;
          out.push({ car, kind: 'crackle', strength: 0.3 + Math.random() * 0.35 });
        }
      } else s.train = 0;
      s.thr = thr; s.gear = car.gear;
    }
    return out;
  }

  train(s, t, n, delay) { s.train = Math.max(s.train, n); s.next = t + delay; }
}
