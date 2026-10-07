// Solo laps through the real EnduranceRace loop, no pit stop inside the measured laps.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/solo.mjs <ai> <lmdh|gt> <track> [laps] [compound] [json-options]
// Prints one JSON line: per-lap times (lap 1 is the standing start), flying best/mean, tyre and incident state.
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT, maxWear } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { createApexBridge, apexState } from '../../../game/bridges/apex-bridge.js';

const [ai = 'apex', cls = 'lmdh', trackName = 'harbor-ring', laps = '6', compound = 'medium', opts = '{}'] = process.argv.slice(2);
const options = JSON.parse(opts), n = Number(laps);
const track = new Track(trackName);
const team = { id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: ai, name: ai, short: ai }], grid: 0 };
const makeBridge = (d, i, race) => d.id === 'apex' && Object.keys(options).length
  ? createApexBridge({ hostTrack: race.track, index: i, options, state: (car) => apexState(race, car) }) : createSeatBridge(d, i, race);
const race = new EnduranceRace({ track, teams: [team], format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, startCompound: compound, makeBridge });
race.start(); race.fitTyres(race.cars[0], compound);
const e = race.entries[0], c = race.cars[0];
e.strategist.decide = () => null;   // measurement rig: no stop inside the laps
const rows = [], t0 = Date.now(), tMax = Math.max(400, track.length / 6) * n;
let lap = 1, offs = 0, maxSlip = 0, lapTemp = null, lapStart = null; const stat = [];
while (c.race.lap <= n && race.time < tMax) {
  race.step(FIXED_DT);
  if (process.env.REARGRIP) for (const w of [c.wheels[2], c.wheels[3]]) w.tyre.gripScale = Number(process.env.REARGRIP);
  if (process.env.FRONTGRIP) for (const w of [c.wheels[0], c.wheels[1]]) w.tyre.gripScale = Number(process.env.FRONTGRIP);
  if (Math.abs(c.lateral) > track.halfWidth + track.curbWidth) offs += FIXED_DT;
  if (c.race.lap !== lap) {
    rows.push(+c.race.lastLap.toFixed(3));
    stat.push({ wear: +maxWear(c).toFixed(3), core: +Math.max(...c.wheels.map((w) => w.tyre.core)).toFixed(1), rear: +Math.max(c.wheels[2].tyre.core, c.wheels[3].tyre.core).toFixed(1), fuel: +c.fuel.toFixed(1), off: +offs.toFixed(1) });
    lap = c.race.lap; offs = 0;
  }
}
const st = race.stewards.of(e), fly = rows.slice(1);
const out = { ai, cls, track: trackName, compound, laps: rows, best: fly.length ? Math.min(...fly) : null, mean: fly.length ? +(fly.reduce((a, b) => a + b, 0) / fly.length).toFixed(3) : null,
  fade: fly.length > 1 ? +(Math.max(...fly) - Math.min(...fly)).toFixed(3) : 0, stat, inc: st.inc, incLog: st.log.map((l) => l.kind), errors: e.bridges[0].errors, lastError: e.bridges[0].lastError?.slice(0, 300) ?? null, wall: +((Date.now() - t0) / 1000).toFixed(1) };
console.log(JSON.stringify(out));
