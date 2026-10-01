import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';

const args = process.argv.slice(2);
const from = Number(args[0] ?? 1100);
const to = Number(args[1] ?? 1320);

const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt' });
session.mode = 'practice';
session.autopilot = true;
session.aiOptions = { planSpeedScale: Number(args[2] ?? 1) };
session.start();
const car = session.cars[0];
const dt = 1 / 120;
const line = session.lineFor(car);
let printing = false;
let nextPrint = 0;
for (let step = 0; step < 120 * 120; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const s = session.drivers[0].ai.state;
  const t = step * dt;
  if (car.s > from && car.s < to) {
    if (t >= nextPrint) {
      nextPrint = t + 0.1;
      const i = session.model.index(car.s);
      console.log(
        `t=${t.toFixed(2)} s=${car.s.toFixed(1).padStart(7)} v=${car.speed.toFixed(1).padStart(5)} q=${car.lateral.toFixed(2).padStart(6)} ` +
        `rlat=${(s.rlat ?? 0).toFixed(2).padStart(5)} rhead=${(s.rhead ?? 0).toFixed(3).padStart(6)} ` +
        `a=${(s.alpha ?? 0).toFixed(3).padStart(6)} pp=${(s.pp ?? 0).toFixed(3).padStart(6)} ff=${(s.ff ?? 0).toFixed(3).padStart(6)} d=${(s.damp ?? 0).toFixed(3).padStart(6)} ` +
        `k=${line.path.kappa[i].toFixed(4).padStart(8)} tgt=${(s.targetSpeed ?? 0).toFixed(1).padStart(5)} ss=${(s.speedScale ?? 1).toFixed(2)} ` +
        `steer=${car.controls.steer.toFixed(2).padStart(5)} thr=${car.controls.throttle.toFixed(2)} brk=${car.controls.brake.toFixed(2)}`,
      );
      printing = true;
    }
  } else if (printing && t > 1) break;
}
