import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';

const [idsArg = 'razor,apex', cls = 'lmdh', lapsArg = '12', weather = 'clear', seedArg = '7', compound] = process.argv.slice(2);
const ids = idsArg.split(','), laps = Number(lapsArg), seed = Number(seedArg), track = new Track('harbor-ring');
const teams = ids.map((id, i) => ({ id: 't' + i, index: i, name: id, short: id, color: '#fff', grid: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3',
  drivers: Array.from({ length: 2 }, () => ({ ...AI_DRIVERS.find(d => d.id === id), kind: 'ai' })) }));
const race = new EnduranceRace({ track, teams, laps, weather, seed, weatherSeed: seed, difficulty: 1, format: FORMATS.classic, startType: 'rolling' });
race.start();
if (compound) for (const car of race.cars) race.fitTyres(car, compound, true);
const t0 = performance.now(), lapSeen = ids.map(() => 1), rows = ids.map(() => []);
let maxWet = 0, minWet = 1;
while (race.phase !== 'finished' && race.time < laps * 180) {
  race.step(FIXED_DT); maxWet = Math.max(maxWet, track.wetness); minWet = Math.min(minWet, track.wetness);
  for (const e of race.entries) {
    const c = e.car, i = e.index ?? race.entries.indexOf(e);
    if (c.race.lap === lapSeen[i]) continue;
    rows[i].push({ lap: lapSeen[i], t: +c.race.lastLap.toFixed(3), valid: c.race.lastState !== 'red' && c.race.lastState !== 'pit',
      compound: c.wheels[0].tyre.compound, wear: +Math.max(...c.wheels.map(w => w.tyre.wear)).toFixed(3), stops: e.strategist.stops });
    lapSeen[i] = c.race.lap;
    if (process.env.RAZOR_PROGRESS) console.error(`${ids[i]} L${c.race.lap} t${race.time.toFixed(1)} ${e.strategist.reason} stops${e.strategist.stops}`);
  }
  if (performance.now() - t0 > 30000) throw new Error(`Probe exceeded 30s wall at sim ${race.time.toFixed(1)}s`);
}
console.log(JSON.stringify({ ids, cls, weather, seed, wet: [minWet, maxWet], sim: +race.time.toFixed(2), wall: +((performance.now() - t0) / 1000).toFixed(2), contacts: race.contacts,
  severe: race.collisionStats.severeContacts, rows: race.entries.map((e, i) => ({ id: ids[i], finish: e.car.race.finishTime, best: e.car.race.bestLap,
    incidents: race.stewards.of(e).log.map(l => l.kind), retired: e.retired, stops: e.strategist.stops, swaps: e.strategist.swaps,
    errors: e.bridges.map(b => b.errors ?? 0), lastError: e.bridges.find(b => b.lastError)?.lastError,
    laps: rows[i], stints: e.stints, decisions: e.strategist.decisions?.slice(-10) })) }));
