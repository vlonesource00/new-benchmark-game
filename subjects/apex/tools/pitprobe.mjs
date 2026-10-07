// What a pit stop costs on a track: race time with a minimal stop (no fuel, no tyres, no swap) against no stop, minus the service time itself.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/pitprobe.mjs --class lmdh --track solenne [--laps 6] [--stop 3] [--write]
// With --write the transit loss is merged into data/stint.json as pit[track][class].
import { readFileSync, writeFileSync } from 'node:fs';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS, serviceTime } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const cls = flag('class', 'lmdh'), trackName = flag('track', 'solenne'), laps = Number(flag('laps', 6)), stopLap = Number(flag('stop', 3));
function run(stop) {
  const track = new Track(trackName);
  const team = { id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [0, 1].map((k) => ({ kind: 'ai', id: 'apex', name: 'apex' + k, short: 'APX' })), grid: 0 };
  const race = new EnduranceRace({ track, teams: [team], format: FORMATS.classic, laps, classId: cls, seed: 7, makeBridge: createSeatBridge });
  const e = race.entries[0], st = e.strategist; st.startCompound = () => 'hard';
  st.decide = (car, lapsLeft) => { const go = stop && laps - lapsLeft + 1 === stopLap; st.boxThisLap = go; st.reason = go ? 'PROBE' : ''; return (st.plan = go ? { litres: 0, tyres: false, compound: 'hard', swap: false } : null); };
  st.servicePlan = (car) => ({ litres: 0, tyres: false, compound: 'hard', swap: false });
  race.start();
  const c = race.cars[0];
  while (c.race.finishTime === null && race.time < 5000) race.step(FIXED_DT);
  return { time: c.race.finishTime, service: serviceTime(race.cal, { litres: 0, tyres: false, swap: false }), cal: race.cal };
}
const base = run(false), stopped = run(true);
const loss = stopped.time - base.time - stopped.service;
console.log(JSON.stringify({ cls, track: trackName, noStop: +base.time.toFixed(2), withStop: +stopped.time.toFixed(2), service: stopped.service, transit: +loss.toFixed(2) }));
if (args.includes('--write')) {
  const file = new URL('../data/stint.json', import.meta.url); let data = {}; try { data = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  ((data.pit ??= {})[trackName] ??= {})[cls] = { transit: +loss.toFixed(2) };
  writeFileSync(file, JSON.stringify(data));
}
