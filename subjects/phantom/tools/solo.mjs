// Solo practice from the standard grid, no state manipulation: PHANTOM vs the
// host's own autopilot, same harness, host lap timing.
import { Track } from '../../../host/astra/src/sim/track.js';
import { Session } from '../../../host/astra/src/sim/session.js';
import { loadGhost } from '../src/ghost-store.js';
import { PhantomDriver } from '../src/phantom-driver.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const LAPS = Number(args.laps ?? 3), WHO = args.who ?? 'phantom';
const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt' });
session.mode = 'practice'; session.field = 1; session.autopilot = true; session.start({ freshTrack: true });
const car = session.player;
if (WHO === 'phantom') {
  const ghost = await loadGhost(track, car);
  session.drivers[0] = new PhantomDriver({ track, ghost, planHz: Number(args.hz ?? 15), options: Object.fromEntries(Object.entries(args).filter(([k]) => k.startsWith('o.')).map(([k, v]) => [k.slice(2), Number(v)])) });
}
session.phase = 'racing'; session.countdown = 0;
let lastLap = car.race.lap, maxLat = 0, t0 = Date.now(), vmax = 0, lapLog = [];
const cross = [];
let prevP = car.race.progress;
for (let i = 0; i < 120 * 100 * (LAPS + 1) && car.race.lap <= LAPS + 1; i++) {
  session.step(1 / 120, {});
  const p = car.race.progress;
  const L = track.length;
  if (Math.floor(prevP / L) !== Math.floor(p / L) && p >= 0) cross.push(session.time);
  if (args.splits && p >= 0) { const b = Math.floor(p / 200), a = Math.floor(prevP / 200); if (b !== a) (globalThis.__sp ??= []).push([Math.floor(p / L), Math.round((p % L) / 200) * 200 % 2800, session.time]); }
  prevP = p;
  if (args.slow && car.speed < 4 && session.time - (globalThis.__slow ?? -9) > 2) { globalThis.__slow = session.time; const d = session.drivers[0]; console.log(`SLOW t ${session.time.toFixed(1)} u ${(car.race.progress % L).toFixed(0)} v ${car.speed.toFixed(1)} lat ${car.lateral.toFixed(1)} yaw-err ${(() => { const q = track.at(car.s); return Math.atan2(Math.sin(car.yaw) * q.nx + Math.cos(car.yaw) * q.nz, Math.sin(car.yaw) * q.tx + Math.cos(car.yaw) * q.tz).toFixed(2); })()} ctl ${JSON.stringify(car.controls)} rec ${d.recoverUntil > session.time}`); }
  { const q = track.at(car.s), ye = Math.atan2(Math.sin(car.yaw) * q.nx + Math.cos(car.yaw) * q.nz, Math.sin(car.yaw) * q.tx + Math.cos(car.yaw) * q.tz);
    if ((Math.abs(ye) > 0.45 && car.speed > 12 || Math.abs(car.lateral) > 8.3) && session.time - (globalThis.__inc ?? -9) > 1.5 && args.inc) { globalThis.__inc = session.time; const g = session.drivers[0].ghost; console.log(`INC t ${session.time.toFixed(1)} lap ${car.race.lap} u ${(car.race.progress % L).toFixed(0)} v ${car.speed.toFixed(1)} gv ${g ? g.speed(g.lapDistance(car.s)).toFixed(1) : ''} lat ${car.lateral.toFixed(1)} ye ${ye.toFixed(2)} yr ${car.yawRate.toFixed(2)} k ${q.curvature.toFixed(4)} cores ${car.wheels.map((w) => w.tyre.core.toFixed(0)).join('/')}`); } }
  maxLat = Math.max(maxLat, Math.abs(car.lateral)); vmax = Math.max(vmax, car.speed);
  if (car.race.lap !== lastLap) {
    lapLog.push(`lap ${lastLap}: host ${car.race.lastLap.toFixed(3)} valid ${car.race.valid} maxLat ${maxLat.toFixed(2)} vmax ${vmax.toFixed(1)} cores ${car.wheels.map((w) => w.tyre.core.toFixed(0)).join("/")} psi ${car.wheels.map((w) => w.tyre.pressure.toFixed(2)).join("/")} dmg ${car.damage.toFixed(3)} wear ${car.wheels[3].tyre.wear.toFixed(3)} fuel ${car.fuel.toFixed(1)}`);
    lastLap = car.race.lap; maxLat = 0; vmax = 0;
  }
}
if (args.splits) { const sp = globalThis.__sp, rows = {}; for (let k = 1; k < sp.length; k++) { const [lap, u, t] = sp[k]; (rows[lap] ??= []).push(`${u}:${(t - sp[k - 1][2]).toFixed(2)}`); } for (const l in rows) console.log('SPL', l, rows[l].join(' ')); }
console.log(WHO, lapLog.join('\n'));
console.log('own crossings deltas', cross.slice(1).map((t, i) => (t - cross[i]).toFixed(3)).join(' '), 'progress', car.race.progress.toFixed(0), 'offtrack', car.race.offtrack.toFixed(2), 'wall', ((Date.now() - t0) / 1000).toFixed(0) + 's');
