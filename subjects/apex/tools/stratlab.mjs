// Strategy lab: race time of one car over a full race with a scripted stop plan, against the host's default strategist.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/stratlab.mjs --class lmdh --track solenne [--laps 12] [--format classic] [--ai apex]
//        [--grid1] [--grid2] [--jobs 4] [--seed 7] [--opts '{}']           enumerate every 1-stop (2-stop) plan and print the ranking
//        [--run S:M:6[,H:7]]                                              one plan: start compound, then compound:stop lap (swap at the first stop)
//        [--default]                                                      the host strategist's own plan
// Plans are `start:next:lap`; litres follow the strategist's own fuel arithmetic (what the next stint needs, never more than the tank).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS, TANK_LITRES } from '../../../game/core/rules.js';
import { TeamStrategist } from '../../../game/core/strategy.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { createApexBridge, apexState } from '../../../game/bridges/apex-bridge.js';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const cls = flag('class', 'lmdh'), trackName = flag('track', 'solenne'), laps = Number(flag('laps', 12)), formatId = flag('format', 'classic'), ai = flag('ai', 'apex');
const seed = Number(flag('seed', 7)), opts = JSON.parse(flag('opts', '{}')), ID = { S: 'soft', M: 'medium', H: 'hard' };

if (args.includes('--run') || args.includes('--default')) {
  const plan = args.includes('--run') ? flag('run', '').split(',').map((s) => s.split(':')) : null;
  const track = new Track(trackName);
  const team = { id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [0, 1].map((k) => ({ kind: 'ai', id: ai, name: ai + k, short: ai })), grid: 0 };
  const makeBridge = (d, i, race) => d.id === 'apex' && Object.keys(opts).length ? createApexBridge({ hostTrack: race.track, index: i, options: opts, state: (car) => apexState(race, car) }) : createSeatBridge(d, i, race);
  const race = new EnduranceRace({ track, teams: [team], format: FORMATS[formatId], laps, classId: cls, seed, makeBridge });
  const e = race.entries[0];
  if (args.includes('--baseline')) e.strategist = new TeamStrategist(team, race.cal, race.format, seed, 0);
  const st = e.strategist;
  const stops = new Map(), prior = Number(flag('prior', 1));
  if (prior !== 1) { for (const id of Object.keys(st.wearPerLap)) st.wearPerLap[id] *= prior; st.memo = null; }
  if (plan) {
    st.startCompound = () => ID[plan[0][0]];
    plan.slice(1).forEach(([c, lap], k) => stops.set(Number(lap), { compound: ID[c], swap: k === 0 }));
    // the host asks twice: decide() at the approach (box or not), servicePlan() at the box (what the stop contains)
    let current = null;
    const content = (car, after) => { const need = Math.min(TANK_LITRES, (after + 0.35) * st.fuelPerLap); return { litres: Math.max(0, Math.min(TANK_LITRES - car.fuel, need - car.fuel)), tyres: true, compound: current.compound, swap: current.swap }; };
    st.decide = (car, lapsLeft) => {
      const lapNo = laps - lapsLeft + 1; current = stops.get(lapNo) ?? null;
      st.boxThisLap = Boolean(current); st.reason = current ? 'SCRIPT' : '';
      return (st.plan = current ? content(car, lapsLeft - 1) : null);
    };
    st.servicePlan = (car, after) => (current ? content(car, after) : { litres: 0, tyres: false, compound: car.wheels[0].tyre.compound, swap: false });
  }
  race.start();
  const c = race.cars[0], rows = [], tyres = []; let last = 1;
  while (c.race.finishTime === null && race.time < 4000) {
    race.step(FIXED_DT);
    if (c.race.lap !== last) { rows.push(+c.race.lastLap.toFixed(2)); tyres.push(c.wheels[0].tyre.compound[0].toUpperCase() + Math.max(...c.wheels.map((w) => w.tyre.wear)).toFixed(2).slice(1)); last = c.race.lap; }
  }
  console.log(JSON.stringify({ plan: args.includes('--run') ? flag('run', '') : 'default', strategist: st.constructor.name, decisions: st.decisions?.slice(0, 40), time: +(c.race.finishTime ?? 9999).toFixed(2), laps: rows, tyres, stops: st.stops, inc: race.stewards.of(e).inc, pit: +e.pitStopTime.toFixed(1), fuel: +c.fuel.toFixed(1) }));
} else {
  const jobs = Number(flag('jobs', 4)), self = fileURLToPath(import.meta.url);
  const plans = [];
  const one = (l) => ['S', 'M', 'H'].flatMap((a) => ['S', 'M', 'H'].map((b) => `${a},${b}:${l}`));
  if (args.includes('--grid1')) for (let l = Math.max(2, Math.floor(laps * 0.2)); l <= Math.min(laps - 1, Math.ceil(laps * 0.8)); l++) plans.push(...one(l));
  const jobsList = [args.includes('--baseline') ? '--default' : '--default', ...plans.map((p) => `--run=${p}`)];
  const results = []; let running = 0, next = 0;
  await new Promise((done) => {
    const pump = () => {
      while (running < jobs && next < jobsList.length) {
        const j = jobsList[next++]; running++;
        const a = j.startsWith('--run=') ? ['--run', j.slice(6)] : [j];
        const p = spawn('node', ['--import', './scripts/json-loader.mjs', self, ...a, '--class', cls, '--track', trackName, '--laps', String(laps), '--format', formatId, '--ai', ai, '--seed', String(seed), '--opts', JSON.stringify(opts), '--prior', flag('prior', '1'), ...(args.includes('--baseline') ? ['--baseline'] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = ''; p.stdout.on('data', (d) => { out += d; });
        p.on('close', () => { try { results.push(JSON.parse(out.trim().split('\n').pop())); } catch { results.push({ plan: j, time: 9999 }); } running--; if (next >= jobsList.length && running === 0) done(); else pump(); });
      }
    };
    pump();
  });
  results.sort((a, b) => a.time - b.time);
  const dflt = results.find((r) => r.plan === 'default');
  console.log(`${cls} ${trackName} ${laps} laps ${formatId} (${ai}); default strategist: ${dflt?.time}  tyres ${dflt?.tyres?.join(' ')} stops ${dflt?.stops} inc ${dflt?.inc}`);
  for (const r of results.slice(0, 12)) console.log(`  ${r.plan.padEnd(10)} ${r.time}  (${(r.time - (dflt?.time ?? 0)).toFixed(1)} vs default)  stops ${r.stops} inc ${r.inc}  tyres ${r.tyres?.join(' ')}`);
  console.log(`  worst ${results.at(-1).plan} ${results.at(-1).time}`);
}
