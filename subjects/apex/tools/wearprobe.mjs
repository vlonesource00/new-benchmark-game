// Tyre wear and temperature of one APEX car over a no-stop stint, per lap, in units of the host strategist's wear prior.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/wearprobe.mjs --class lmdh --track solenne --laps 12 --compound hard [--stint 8] [--opts '{}'] [--seed 7]
// Prints one JSON line: per lap time, worst-wheel wear, core temperature (worst axle), and the wear gain over the prior (the "ratio").
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS, COMPOUNDS, WEAR_CLIFF } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { createApexBridge, apexState } from '../../../game/bridges/apex-bridge.js';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const cls = flag('class', 'lmdh'), trackName = flag('track', 'solenne'), laps = Number(flag('laps', 12)), compound = flag('compound', 'medium'), stint = Number(flag('stint', 8));
const seed = Number(flag('seed', 7)), opts = JSON.parse(flag('opts', '{}')), formatId = flag('format', 'classic');
const track = new Track(trackName);
const team = { id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [0, 1].map((k) => ({ kind: 'ai', id: 'apex', name: 'apex' + k, short: 'APX' })), grid: 0 };
const makeBridge = (d, i, race) => (Object.keys(opts).length ? createApexBridge({ hostTrack: race.track, index: i, options: opts, state: (car) => apexState(race, car) }) : createSeatBridge(d, i, race));
const race = new EnduranceRace({ track, teams: [team], format: FORMATS[formatId], laps, classId: cls, seed, makeBridge });
const e = race.entries[0], st = e.strategist, after = args.includes('--afterstop');
// --afterstop: start on another set, stop at the end of lap 2 for `compound` and record the stint after the stop (laps 4 onward: lap 3 is the out-lap)
st.startCompound = () => (after ? (compound === 'hard' ? 'medium' : 'hard') : compound);
let boxed = false;
st.decide = (car, lapsLeft) => { const go = after && !boxed && laps - lapsLeft + 1 === 2; if (go) boxed = true; st.boxThisLap = go; st.reason = go ? 'PROBE' : ''; return (st.plan = go ? { litres: 60, tyres: true, compound, swap: true } : null); };
st.servicePlan = (car) => ({ litres: Math.min(60 - car.fuel, 45), tyres: true, compound, swap: true });
race.start();
const c = race.cars[0], prior = WEAR_CLIFF * COMPOUNDS[compound].wear / race.cal.tyreLaps;
const rows = []; let last = 1, prev = 0, started = !after;
while (c.race.lap <= stint && c.race.finishTime === null && race.time < 6000) {
  race.step(FIXED_DT);
  if (c.race.lap !== last) {
    const wear = Math.max(...c.wheels.map((w) => w.tyre.wear)), cores = c.wheels.map((w) => w.tyre.core);
    if (after && last === 3) { prev = 0; started = true; }
    rows.push({ lap: last, t: +c.race.lastLap.toFixed(2), wear: +wear.toFixed(3), dw: +((wear - prev) / prior).toFixed(2), core: +Math.max(...cores).toFixed(0), coreMin: +Math.min(...cores).toFixed(0), fuel: +c.fuel.toFixed(1) });
    if (!started) rows.pop();
    prev = wear; last = c.race.lap;
  }
}
console.log(JSON.stringify({ cls, track: trackName, laps, compound, tyreLaps: +race.cal.tyreLaps.toFixed(2), fuelLaps: race.cal.fuelLaps, prior: +prior.toFixed(4), rows }));
