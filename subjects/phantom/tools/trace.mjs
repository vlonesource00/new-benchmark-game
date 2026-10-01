import { Track } from '../../../host/astra/src/sim/track.js';
import { Session } from '../../../host/astra/src/sim/session.js';
import { loadGhost } from '../src/ghost-store.js';
import { seedGhost } from '../src/ghost.js';
import { PhantomDriver } from '../src/phantom-driver.js';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt' });
session.mode = 'practice'; session.field = 1; session.autopilot = true; session.start({ freshTrack: true });
const car = session.player;
let ghost;
if (args.seed) { ghost = seedGhost(track); ghost.calibrate(track, car); ghost.buildEnvelope(); } else ghost = await loadGhost(track, car);
session.drivers[0] = new PhantomDriver({ track, ghost });
session.phase = 'racing'; session.countdown = 0;
const every = Number(args.every ?? 60), t0 = Number(args.from ?? 0);
for (let i = 0; i < 120 * Number(args.t ?? 30); i++) {
  session.step(1 / 120, {});
  if (i % every === 0 && session.time >= t0) {
    const u = ghost.lapDistance(car.s);
    console.log(`t ${session.time.toFixed(2)} p ${car.race.progress.toFixed(0)} u ${u.toFixed(0)} v ${car.speed.toFixed(1)} gv ${ghost.speed(u).toFixed(1)} cap ${ghost.capAt(u).toFixed(1)} lat ${car.lateral.toFixed(2)} gq ${ghost.lateral(u).toFixed(2)} thr ${car.controls.throttle.toFixed(2)} brk ${car.controls.brake.toFixed(2)} st ${car.controls.steer.toFixed(2)} yr ${car.yawRate.toFixed(2)} aF ${car.wheels[0].tyre.alpha.toFixed(2)} aR ${car.wheels[3].tyre.alpha.toFixed(2)} kR ${car.wheels[3].tyre.kappa.toFixed(2)} k ${track.at(car.s).curvature.toFixed(4)}`);
  }
}
