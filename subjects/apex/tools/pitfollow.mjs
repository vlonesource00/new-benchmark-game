// Pit-follow test: APEX runs close behind a car that is called to the pits, and what it does while that car brakes and peels off.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/pitfollow.mjs [lmdh|gt] [track] [--box=3] [--opts='{"margin":0.9}'] [--trace] [--seed=7]
// Car 0 is an SPH car forced to box on lap `box`; car 1 is APEX (a little slower by default so it stays behind). One JSON line:
// APEX's lowest speed and hardest braking from the box call to 3 s after the rival is in the lane, the closest it came, and the passes it counted.
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { createApexBridge, apexState } from '../../../game/bridges/apex-bridge.js';

const pos = process.argv.slice(2).filter((a) => !a.startsWith('--')), flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [cls = 'lmdh', trackName = 'harbor-ring'] = pos, box = Number(flags.box ?? 3), opts = JSON.parse(flags.opts ?? '{"margin":0.9}'), track = new Track(trackName);
const teams = ['next-racer', 'apex'].map((id, i) => ({ id: 't' + i, name: id + i, short: id.slice(0, 3).toUpperCase() + i, color: '#fff', index: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id, name: id, short: id.slice(0, 3).toUpperCase() }], grid: i }));
const makeBridge = (d, i, race) => (d.id === 'apex' ? createApexBridge({ hostTrack: race.track, index: i, options: opts, state: (car) => apexState(race, car) }) : createSeatBridge(d, i, race));
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, startCompound: 'medium', makeBridge, startType: 'rolling', seed: Number(flags.seed ?? 7) });
const sph = race.entries[0], st = sph.strategist, apx = race.entries[1];
st.decide = (car) => { const go = car.race.lap === box; st.boxThisLap = go; st.reason = go ? 'TEST' : ''; return (st.plan = go ? { litres: 20, tyres: false, compound: 'medium', swap: false } : null); };
st.servicePlan = () => ({ litres: 20, tyres: false, compound: 'medium', swap: false });
apx.strategist.decide = () => null;
race.start();
const [a, b] = race.cars, L = track.length, drv = apx.bridges[0].driver;
let from = null, inLane = null, minV = Infinity, maxBrake = 0, minGap = Infinity, minAt = null; const trace = [];
while (race.time < 400 && !(inLane != null && race.time - inLane > 3)) {
  race.step(FIXED_DT);
  if (race.formation) continue;
  if (from == null && a.race.boxThisLap) from = race.time;
  if (from != null && inLane == null && sph.pit?.phase === 'lane') inLane = race.time;
  if (from == null) continue;
  const ds = ((a.s - b.s + L * 1.5) % L) - L / 2;
  if (ds > 0 && ds < 400 && Math.abs(ds) < minGap) { minGap = ds; minAt = { t: +race.time.toFixed(1), v: +b.speed.toFixed(1), rv: +a.speed.toFixed(1) }; }
  minV = Math.min(minV, b.speed); maxBrake = Math.max(maxBrake, b.controls.brake);
  if (flags.trace && Math.round(race.time / FIXED_DT) % 30 === 0) trace.push(`t${race.time.toFixed(1)} ds${ds.toFixed(0)} apx v${b.speed.toFixed(0)} lat${b.lateral.toFixed(1)} brk${b.controls.brake.toFixed(2)} | sph v${a.speed.toFixed(0)} lat${a.lateral.toFixed(1)} pit ${sph.pit?.phase ?? '-'}`);
}
if (flags.trace) console.error(trace.join('\n'));
const cs = drv?.combat?.stats ?? {};
console.log(JSON.stringify({ cls, track: trackName, boxCall: from && +from.toFixed(1), inLane: inLane && +inLane.toFixed(1), apexMinSpeed: +minV.toFixed(1), apexMaxBrake: +maxBrake.toFixed(2), closest: minGap === Infinity ? null : +minGap.toFixed(1), closestAt: minAt, passesCounted: cs.passes ?? 0, lost: cs.lost ?? 0, contacts: race.collisionStats?.pairs?.length ?? 0 }));
