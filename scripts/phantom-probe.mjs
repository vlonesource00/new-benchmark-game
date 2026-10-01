// Probe: run a session (GRID=ids, COUNTDOWN=1, TWIN=t0,t1 or WIN=u0,u1,lap), dump planner candidate cost terms in a u window on a given lap.
import { Track } from '../host/astra/src/sim/track.js';
import { Session } from '../host/astra/src/sim/session.js';
import { createField, ALL_KNOWN_CANDIDATES } from '../sandbox/bridges/index.js';
const [U0, U1, LAP] = (process.env.WIN ?? '700,800,1').split(',').map(Number);
const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt', mixed: false });
const grid = (process.env.GRID ?? 'phantom').split(',');
session.laps = 3; session.field = grid.length; session.cars = session.cars.slice(0, grid.length); session.drivers = session.drivers.slice(0, grid.length); session.autopilot = true;
const field = createField({ session, hostTrack: track, order: grid, candidatesList: ALL_KNOWN_CANDIDATES });
session.start({ freshTrack: true }); field.attach(true);
if (!process.env.COUNTDOWN) { session.phase = 'racing'; session.countdown = 0; }
const [T0, T1] = (process.env.TWIN ?? '0,1e9').split(',').map(Number);
const bridge = field.byId('phantom'), car = session.cars[bridge.carId];
const f = (x) => typeof x === 'number' ? +x.toFixed(2) : x;
for (let i = 0; i < 400 * 120; i++) {
  const d = bridge.driver, pl = d?.planner;
  const u = d ? d.ghost.lapDistance(car.s) : 0;
  const on = d && (process.env.TWIN ? session.time > T0 && session.time < T1 : car.race.lap === LAP && u > U0 && u < U1);
  if (pl) pl.dbg = on ? [] : null;
  const plans = pl?.stats.plans;
  session.step(1 / 120, { throttle: 0, brake: 0, steer: 0 });
  if (on && pl.stats.plans !== plans && pl.dbg.length) {
    const g = d.ghost, ds = pl.dbg, structured = ds.filter((r) => r.kind !== 'knots');
    const best = ds.reduce((a, b) => (b.J < a.J ? b : a));
    console.log(`t=${session.time.toFixed(2)} u=${u.toFixed(1)} v=${car.speed.toFixed(1)} vg=${g.speed(u).toFixed(1)} q=${car.lateral.toFixed(2)} qg=${g.lateral(u).toFixed(2)} cap(u)=${g.capAt(u).toFixed(1)} near=${JSON.stringify(session.cars.filter((o)=>o!==car).map((o)=>[o.id,+(((o.s-car.s+track.length*1.5)%track.length)-track.length/2).toFixed(1),+o.lateral.toFixed(1),+o.speed.toFixed(1)]).filter((n)=>Math.abs(n[1])<30))} best=${f(pl.stats.best)}`);
    for (const r of [...structured, { ...best, kind: 'BEST' }]) console.log('  ', r.kind.padEnd(14), Object.entries(r).filter(([k]) => k !== 'kind').map(([k, v]) => `${k}=${f(v)}`).join(' '));
  }
  if (process.env.TWIN ? session.time > T1 : car.race.lap > LAP) break;
}
