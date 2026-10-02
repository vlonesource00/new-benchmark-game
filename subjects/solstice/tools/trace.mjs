import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { RacingPath } from '../src/path.js';
import { ForcePolicy } from '../src/policy.js';
import { SolsticeDriver } from '../src/driver.js';

const track = new Track(process.argv[2] ?? 'harbor-ring');
const options = JSON.parse(process.env.SOLSTICE_OPTIONS ?? '{}');
const car = new Vehicle(0); car.place(track, track.gridS, 0);
const driver = new SolsticeDriver(track, options);
driver.path = new RacingPath(track, { brakeReserve: .8, ...options.path, car });
driver.policy = new ForcePolicy(track, driver.path, options.policy);
const path = driver.path, policy = driver.policy;
let lastMark = 0, off = 0, distance = 0, lastS = car.s, crossed = false, start = 0;
const rows = [], laps = [];
for (let t = 0; t < Number(process.argv[3] ?? 180); t += 1 / 120) {
  const p = track.nearest(car.x, car.z);
  if (process.argv.includes('--policy')) {
    if (t >= lastMark) { path.rebuildEnvelope(car, policy.o.gripUse); lastMark = t + .33; }
    car.controls = policy.control(car, p, {});
  } else driver.update(car, [car], 1 / 120, { time: t, totalLaps: 6 });
  car.step(1 / 120, track);
  distance += ((car.s - lastS + track.length * 1.5) % track.length) - track.length / 2; lastS = car.s;
  const invalid = Math.abs(car.lateral) > track.halfWidth + track.curbWidth;
  if (invalid) off += 1 / 120;
  if ((Math.abs(car.lateral) > track.halfWidth - .2 || Math.abs(Math.atan2(car.v,car.u)) > .22) && (!rows.length || t - rows.at(-1).t > 2)) rows.push({t:+t.toFixed(2),s:+car.s.toFixed(1),lat:+car.lateral.toFixed(2),q:+path.at(car.s).offset.toFixed(2),v:+car.speed.toFixed(2),target:+policy.targetSpeed.toFixed(2),steer:+car.controls.steer.toFixed(3),beta:+Math.atan2(car.v,car.u).toFixed(3),yawRate:+car.yawRate.toFixed(3),k:+path.at(car.s).curvature.toFixed(4),plan:driver.selected});
  if (distance > track.length * (laps.length + 1)) { laps.push({time:t-start,off});start=t;off=0; }
}
console.log(JSON.stringify({track:track.id,estimated:path.estimatedLapTime,laps,rows:rows.slice(0,18),end:{speed:car.speed,s:car.s,lat:car.lateral},stats:driver.stats}));
