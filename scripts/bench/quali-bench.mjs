// Qualifying bench: every AI in one ghosted qualifying session (soft tyres, light fuel, out lap + timed laps), per
// track and class. Prints each AI's best lap and its timed laps. TEMPEST options via --opts.
//   node --import ./scripts/json-loader.mjs scripts/bench/quali-bench.mjs [--tracks harbor-ring,solenne,alpine,desert]
//        [--classes lmdh,gt] [--ais tempest,razor,apex,next-racer] [--opts '{}'] [--weather clear]
import { Track } from '../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../game/core/race.js';
import { FORMATS } from '../../game/core/rules.js';
import { AI_DRIVERS } from '../../game/core/teams.js';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const tracks = flag('tracks', 'harbor-ring,solenne,alpine,desert').split(','), classes = flag('classes', 'lmdh,gt').split(',');
const ais = flag('ais', 'tempest,razor,apex,next-racer').split(','), opts = JSON.parse(flag('opts', '{}')), weather = flag('weather', 'clear');
const short = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
const best = {};
for (const trackName of tracks) for (const cls of classes) {
  const track = new Track(trackName);
  const teams = ais.map((id, i) => ({ id: 'q' + i, name: short(id), short: short(id), color: '#fff', index: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', grid: i,
    drivers: [{ kind: 'ai', id, name: id, short: short(id) }] }));
  const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, session: 'qualifying', seed: 7, weatherSeed: 7, weather });
  race.start();
  race.step(FIXED_DT);
  race.entries.forEach((e, i) => { const d = e.bridges[0]?.driver; if (ais[i] === 'tempest' && d) { Object.assign(d.options, opts); d.forceRefresh = true; } if (ais[i] === 'next-racer' && d?.o) d.o.planBudgetMs = Infinity; });
  const laps = ais.map(() => []), lastLap = ais.map(() => null);
  while (race.phase !== 'finished') {
    race.step(FIXED_DT);
    race.cars.forEach((c, i) => { if (c.race.lastLap !== lastLap[i]) { lastLap[i] = c.race.lastLap; if (c.race.lastLap != null) laps[i].push(c.race.lastLap); } });
  }
  const row = race.cars.map((c, i) => `${short(ais[i])} ${c.race.bestLap?.toFixed(3) ?? '-'} (${laps[i].map((x) => x.toFixed(2)).join(' ')})`).join('  ');
  console.log(`${trackName.padEnd(12)} ${cls.padEnd(4)} ${row}`);
  race.cars.forEach((c, i) => { const k = `${ais[i]} ${cls}`; (best[k] ??= []).push(c.race.bestLap ?? NaN); });
}
console.log('\nmean best lap per AI and class (over tracks):');
for (const [k, v] of Object.entries(best)) console.log(`${k.padEnd(18)} ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3)}`);
