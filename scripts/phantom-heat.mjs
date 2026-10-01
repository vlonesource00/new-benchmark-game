// Per-wheel heat budget: longitudinal slip, lateral slip, rolling (J), binned by lap distance.
// usage: node scripts/phantom-heat.mjs [laps] [bin]
import { Track } from '../host/astra/src/sim/track.js';
import { Session } from '../host/astra/src/sim/session.js';
import { createField, ALL_KNOWN_CANDIDATES } from '../sandbox/bridges/index.js';
const laps = +(process.argv[2] ?? 2), BIN = +(process.argv[3] ?? 100);
const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt', mixed: false });
session.laps = laps; session.field = 1; session.cars = session.cars.slice(0, 1); session.drivers = session.drivers.slice(0, 1);
session.autopilot = true;
const field = createField({ session, hostTrack: track, order: ['phantom'], candidatesList: ALL_KNOWN_CANDIDATES });
session.start({ freshTrack: true }); field.attach(true); session.phase = 'racing'; session.countdown = 0;
const bridge = field.byId('phantom'), car = session.cars[bridge.carId], DT = 1 / 120;
const nb = Math.ceil(track.length / BIN), acc = [];
const newLap = () => Array.from({ length: nb }, () => Array.from({ length: 4 }, () => [0, 0, 0]));
let lap = car.race.lap, cur = newLap(); const times = [];
for (let i = 0; i < (laps * 100 + 30) * 120; i++) {
  session.step(DT, { throttle: 0, brake: 0, steer: 0 });
  if (car.race.lap > lap) { acc.push(cur); cur = newLap(); lap = car.race.lap; times.push(+car.race.lastLap.toFixed(2)); }
  if (car.race.finishTime != null) break;
  const g = bridge.driver?.ghost; if (!g) continue;
  const b = Math.min(nb - 1, Math.floor(g.lapDistance(car.s) / BIN));
  car.wheels.forEach((w, k) => {
    const t = w.tyre, sx = Math.abs(t.fx * t.kappa), sy = Math.abs(t.fy * Math.tan(t.alpha));
    const tot = sx + sy || 1, sp = t.slipPower * DT;
    cur[b][k][0] += sp * sx / tot; cur[b][k][1] += sp * sy / tot; cur[b][k][2] += (w.load ?? 0) * car.speed * 0.012 * DT;
  });
}
console.log('laps', times, 'cores', car.wheels.map((w) => w.tyre.core.toFixed(0)).join(' '));
const L = acc[acc.length - 1] ?? cur, tot = [0, 1, 2, 3].map(() => [0, 0, 0]);
console.log('bin  | FL long/lat  FR long/lat  RL long/lat  RR long/lat (kJ)');
L.forEach((row, b) => {
  row.forEach((w, k) => w.forEach((v, j) => (tot[k][j] += v)));
  const s = row.map((w) => `${(w[0] / 1e3).toFixed(0).padStart(4)}/${(w[1] / 1e3).toFixed(0).padStart(3)}`).join('  ');
  if (row.some((w) => w[0] + w[1] > 15e3)) console.log(String(b * BIN).padStart(4), '|', s);
});
console.log('TOTAL long/lat/roll kJ:', tot.map((w, k) => ['FL', 'FR', 'RL', 'RR'][k] + ' ' + w.map((v) => (v / 1e3).toFixed(0)).join('/')).join('  '));
