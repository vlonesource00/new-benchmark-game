import { Track } from '../../../host/astra/src/sim/track.js';
import { Session } from '../../../host/astra/src/sim/session.js';
import { createAstraBridge } from '../../../sandbox/bridges/astra-bridge.js';
import { tyreGrip } from '../../../host/astra/src/sim/tyre.js';
const track = new Track('harbor-ring'); const session = new Session(track, { classId: 'gt' });
session.mode = 'practice'; session.field = 1; session.autopilot = true; session.start({ freshTrack: true });
session.drivers[0] = createAstraBridge({ line: session.lineFor(session.player), index: 0 }); session.phase = 'racing'; session.countdown = 0;
const car = session.player; let lap = 1, acc = null;
const reset = () => ({ n: 0, core: [0,0,0,0], surf: [0,0,0,0], maxCore: [0,0,0,0], grip: [0,0,0,0], p: [0,0,0,0] });
acc = reset();
for (let i = 0; i < 120 * 330 && lap <= 4; i++) {
  session.step(1 / 120, {});
  car.wheels.forEach((w, k) => { acc.core[k] += w.tyre.core; acc.surf[k] += w.tyre.surface; acc.maxCore[k] = Math.max(acc.maxCore[k], w.tyre.core); acc.grip[k] += tyreGrip(w.tyre, 3300) / 1.48; acc.p[k] += w.tyre.pressure; });
  acc.n++;
  if (car.race.lap > lap) {
    const f = a => a.map(v => (v / acc.n).toFixed(2)).join(' ');
    console.log(`lap ${lap} ${car.race.lastLap.toFixed(2)} core[FL FR RL RR] ${f(acc.core)} max ${acc.maxCore.map(v=>v.toFixed(0)).join(' ')} surf ${f(acc.surf)} gripFactor ${f(acc.grip)} press ${f(acc.p)} wear ${car.wheels.map(w => w.tyre.wear.toFixed(4)).join(' ')}`);
    lap = car.race.lap; acc = reset();
  }
}
