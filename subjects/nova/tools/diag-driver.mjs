import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';

const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt' });
session.mode = 'practice';
session.autopilot = true;
session.start();
const car = session.cars[0];
const driver = session.drivers[0];
const dt = 1 / 120;
for (let step = 0; step < 600; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  if (step % 40 === 0) {
    const s = driver.ai.state;
    console.log(
      `step ${String(step).padStart(4)} phase=${session.phase} s=${car.s.toFixed(1).padStart(7)} q=${car.lateral.toFixed(2).padStart(6)} v=${car.speed.toFixed(1).padStart(5)} ` +
      `steer=${car.controls.steer.toFixed(3).padStart(7)} thr=${car.controls.throttle.toFixed(2)} brk=${car.controls.brake.toFixed(2)} ` +
      `intent=${s.intent} rlat=${(s.rlat ?? 0).toFixed(2)} cause=${s.cause}`,
    );
  }
}
console.log('line time', session.lineFor(car).time.toFixed(2), 's');
