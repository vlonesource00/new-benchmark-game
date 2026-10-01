import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';
import { observeVehicle } from '../src/sim/native-adapter.js';

const args = process.argv.slice(2);
const from = Number(args[0] ?? 1180);
const to = Number(args[1] ?? 1280);
const scale = Number(args[2] ?? 0.9);

const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt' });
session.mode = 'practice';
session.autopilot = true;
session.aiOptions = { planSpeedScale: scale };
session.start();
const car = session.cars[0];
const ai = session.drivers[0].ai;
const dt = 1 / 120;
let nextPrint = 0;
for (let step = 0; step < 120 * 120; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const t = step * dt;
  if (step % 240 === 0) {
    console.log(`  .. t=${t.toFixed(1)} s=${car.s.toFixed(0)} v=${car.speed.toFixed(1)} q=${car.lateral.toFixed(1)}`);
  }
  if (car.s > from && car.s < to && t >= nextPrint) {
    nextPrint = t + 0.15;
    const obs = observeVehicle(car, [car], { time: session.time }, dt);
    const lat = ai.tracker.command(obs.ego, ai.model, ai.line.path, dt);
    console.log(
      `t=${t.toFixed(2)} s=${car.s.toFixed(0).padStart(5)} v=${car.speed.toFixed(1).padStart(5)} ` +
      `elat=${lat.elat.toFixed(2).padStart(6)} ehead=${lat.ehead.toFixed(3).padStart(6)} alpha=${lat.alpha.toFixed(3).padStart(6)} ` +
      `pp=${lat.pp.toFixed(3).padStart(6)} ff=${lat.ff.toFixed(3).padStart(6)} damp=${lat.damp.toFixed(3).padStart(6)} ` +
      `steer=${car.controls.steer.toFixed(2).padStart(5)} yawRate=${car.yawRate.toFixed(3).padStart(7)}`,
    );
  }
  if (car.s > to && t > 5 && car.race.lap > 1) break;
}
