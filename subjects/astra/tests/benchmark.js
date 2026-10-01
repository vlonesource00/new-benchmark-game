import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';
const session = new Session(new Track());
session.field = Number(process.env.FIELD || 6); session.laps = 3; session.autopilot = true; session.start();
const wallStart = performance.now();
let maxLateral = 0, steps = 0;
for (; steps < 120*420 && session.phase !== 'finished'; steps++) {
  session.step(1/120,{});
  maxLateral = Math.max(maxLateral,...session.activeCars.map(c => Math.abs(c.lateral)));
  if (session.activeCars.some(c => !Number.isFinite(c.x+c.z+c.speed))) throw new Error('Non-finite vehicle');
}
const summary = { simulatedSeconds: +(steps/120).toFixed(1), wallSeconds:+((performance.now()-wallStart)/1000).toFixed(1), phase:session.phase, contacts:session.contacts, maxLateral:+maxLateral.toFixed(2), cars:session.standings().map(c=>({name:c.name,lap:c.race.lap,progress:Math.round(c.race.progress),best:c.race.bestLap,last:c.race.lastLap,offtrack:+c.race.offtrack.toFixed(1),damage:+c.damage.toFixed(2)})) };
console.log(JSON.stringify(summary,null,2));
if (session.phase !== 'finished') process.exitCode=1;
