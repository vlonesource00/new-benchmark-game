// Where does each tyre's sliding energy come from? Per 200 m bin of lap
// distance, longitudinal vs lateral sliding kJ per wheel, over N laps.
import { Track } from '../../../host/astra/src/sim/track.js';
import { Session } from '../../../host/astra/src/sim/session.js';
import { loadGhost } from '../src/ghost-store.js';
import { PhantomDriver } from '../src/phantom-driver.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const LAPS = Number(args.laps ?? 2), BIN = 200;
const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt' });
session.mode = 'practice'; session.field = 1; session.autopilot = true; session.start({ freshTrack: true });
const car = session.player;
const ghost = await loadGhost(track, car);
if ((args.who ?? 'phantom') === 'phantom') session.drivers[0] = new PhantomDriver({ track, ghost });
session.phase = 'racing'; session.countdown = 0;
const nb = Math.ceil(track.length / BIN);
const lon = Array.from({ length: 4 }, () => new Float64Array(nb)), lat = Array.from({ length: 4 }, () => new Float64Array(nb));
const dt = 1 / 120;
const hist = Array.from({ length: 4 }, () => new Float64Array(12));
while (car.race.lap <= LAPS && session.time < 100 * (LAPS + 1)) {
  session.step(dt, {});
  if (car.race.progress < 0) continue;
  const b = Math.floor(ghost.lapDistance(car.s) / BIN);
  car.wheels.forEach((w, i) => {
    const t = w.tyre, v = Math.max(2.5, Math.abs(car.speed));
    const pl = Math.abs(t.fx * t.kappa * v), pa = Math.abs(t.fy * Math.tan(t.alpha) * v);
    const k = pl + pa > 0 ? t.slipPower / (pl + pa) : 0;
    const sl = Math.hypot(t.kappa * 10.5, Math.tan(Math.max(-1.2, Math.min(1.2, t.alpha))) * 8.6);
    if (sl > 5.5 && args.events && session.time > (globalThis.lastEv ?? 0) + 0.25) { globalThis.lastEv = session.time; console.log(`EV t ${session.time.toFixed(2)} u ${ghost.lapDistance(car.s).toFixed(0)} w${i} v ${car.speed.toFixed(1)} lat ${car.lateral.toFixed(2)} kap ${t.kappa.toFixed(2)} alp ${t.alpha.toFixed(2)} yawR ${car.yawRate.toFixed(2)} thr ${car.controls.throttle.toFixed(2)} brk ${car.controls.brake.toFixed(2)} st ${car.controls.steer.toFixed(2)} gear ${car.gear}`); }
    hist[i][Math.min(11, Math.floor(sl / 0.5))] += t.slipPower * dt / 1000;
    lon[i][b] += pl * k * dt / 1000; lat[i][b] += pa * k * dt / 1000;
  });
}
const f = (x) => x.toFixed(0).padStart(5);
console.log('bin    ' + ['FL', 'FR', 'RL', 'RR'].map((n) => `${n}lon ${n}lat`).join(' '));
for (let b = 0; b < nb; b++) console.log(String(b * BIN).padStart(5), [0, 1, 2, 3].map((i) => f(lon[i][b]) + '  ' + f(lat[i][b])).join('  '));
console.log('total', [0, 1, 2, 3].map((i) => f(lon[i].reduce((a, c) => a + c)) + '  ' + f(lat[i].reduce((a, c) => a + c))).join('  '));
console.log('cores', car.wheels.map((w) => w.tyre.core.toFixed(0)).join('/'), 'laps', car.race.lap, 'last', car.race.lastLap.toFixed(2));
console.log('kJ by combined slip (0.5 buckets):');
['FL', 'FR', 'RL', 'RR'].forEach((n, i) => console.log(n, Array.from(hist[i], (x) => x.toFixed(0).padStart(5)).join('')));
