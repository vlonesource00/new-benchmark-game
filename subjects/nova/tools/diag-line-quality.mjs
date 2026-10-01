// Run the DeepSeek driver on a synthetic line (centerline or a scaled version
// of the baked line) to separate controller quality from line quality.
import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';
import { RaceLine } from '../src/ai/race-line.js';
import { makeBasis } from '../src/ai/global/line-optimizer.js';

const args = process.argv.slice(2);
const mode = args[0] ?? 'center';
const scale = Number(args[1] ?? 1);
const maxSeconds = Number(args[2] ?? 150);

const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt' });
session.mode = 'practice';
session.laps = 4;
session.autopilot = true;
const baked = session.lineForClass('gt');
const envelope = baked.envelope;
let line;
if (mode === 'center') {
  const widths = [96];
  const basis = makeBasis(session.model, { widths });
  line = new RaceLine(session.model, envelope, { widths, coeffs: new Float64Array(basis.count) });
} else {
  line = new RaceLine(session.model, envelope, { widths: baked.widths, overlap: baked.overlap ?? 2, coeffs: baked.coeffs.map((c) => c * scale) });
}
session.lineForClass = () => line;
session.start();

const car = session.cars[0];
const dt = 1 / 120;
let maxQ = 0;
let offtrack = 0;
let worst = { elat: 0 };
console.log(`start: plan ${line.time.toFixed(2)} s, mode ${mode}`);
for (let step = 0; step < 120 * maxSeconds; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  maxQ = Math.max(maxQ, Math.abs(car.lateral));
  const st = session.drivers[0].ai.state;
  if (Math.abs(st.rlat) > Math.abs(worst.elat)) worst = { elat: st.rlat, t: step * dt, s: car.s };
  if (step % 1200 === 0) console.log(`  t=${(step * dt).toFixed(0)} s=${car.s.toFixed(0)} v=${car.speed.toFixed(1)} offt=${car.race.offtrack.toFixed(1)} lap=${car.race.lap}`);
  if (car.race.lastLap !== null && car.race.lap > 3) break;
}
console.log(JSON.stringify({
  mode, scale,
  planTime: line.time,
  lap: car.race.lap,
  lastLap: car.race.lastLap,
  bestLap: car.race.bestLap,
  offtrack: Number(car.race.offtrack.toFixed(2)),
  maxAbsQ: Number(maxQ.toFixed(2)),
  worstElat: Number(worst.elat.toFixed(2)),
  worstAt: worst.t ? `t=${worst.t.toFixed(1)} s=${worst.s?.toFixed(0)}` : null,
}, null, 1));
