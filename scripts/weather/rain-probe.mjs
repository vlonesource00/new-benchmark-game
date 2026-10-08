// Rain probe: a short race in rain or changeable weather, printing per lap what the road and the cars do with it.
// usage: node --import ./scripts/json-loader.mjs scripts/weather/rain-probe.mjs [ais=razor,apex,next-racer] [weather=rain]
//        [track=harbor-ring] [laps=6] [seed=7] [cls=lmdh] [format=classic]
import { Track } from '../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../game/core/race.js';
import { FORMATS } from '../../game/core/rules.js';
import { AI_DRIVERS } from '../../game/core/teams.js';
import { wetFrac } from '../../game/engine/sim/water.js';

const [aisArg = 'razor,apex,next-racer', weather = 'rain', trackName = 'harbor-ring', lapsArg = '6', seedArg = '7', cls = 'lmdh', fmt = 'classic'] = process.argv.slice(2);
const ais = aisArg.split(','), laps = Number(lapsArg), seed = Number(seedArg), track = new Track(trackName);
const short = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
const teams = ais.map((id, i) => ({ id: 't' + i, index: i, name: short(id) + i, short: short(id) + i, color: '#fff', grid: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3',
  drivers: Array.from({ length: 2 }, () => ({ kind: 'ai', id, name: id, short: short(id) })) }));
const race = new EnduranceRace({ track, teams, laps, weather, seed, weatherSeed: seed, format: { ...FORMATS[fmt], laps }, startType: 'rolling' });
race.start();
const t0 = performance.now(), seen = race.cars.map(() => 1), stat = race.cars.map(() => ({ aqua: 0, off: 0, minVis: 1, spray: 0, n: 0 }));
const lineWet = () => { // wetness on the cells the cars actually drive vs the whole road
  let a = 0, n = 0; for (const c of race.cars) { const p = track.nearest(c.x, c.z); a += track.wetAt(p.index, track.laneAt(p.lateral)); n++; } return n ? a / n : 0;
};
const puddles = () => { let p = 0; for (const d of track.water.depth) if (d > 1.5) p++; return p / track.water.depth.length; };
console.log(`${trackName} ${cls} ${weather} ${laps}L seed ${seed}: start wet ${track.wetness.toFixed(2)} tyres ${race.cars.map((c) => c.wheels[0].tyre.compound).join(',')}`);
let lastLog = 0;
while (race.phase !== 'finished' && race.time < laps * 200) {
  race.step(FIXED_DT);
  race.cars.forEach((c, i) => {
    const s = stat[i]; s.n++; if (c.wheels.some((w) => w.aqua > 0.3)) s.aqua++; if (c.zone !== 'asphalt' && c.zone !== 'kerb') s.off++;
    s.minVis = Math.min(s.minVis, c.visibility ?? 1); s.spray = Math.max(s.spray, c.spray ?? 0);
    if (c.race.lap !== seen[i]) { seen[i] = c.race.lap; }
  });
  if (race.time - lastLog >= 60) {
    lastLog = race.time; const w = race.weather.snapshot();
    console.log(`t${race.time.toFixed(0).padStart(4)} rain ${w.mmh.toFixed(1)}mm/h phase ${w.phase ?? '-'} road ${track.wetness.toFixed(2)} line ${lineWet().toFixed(2)} puddles ${(puddles() * 100).toFixed(1)}% | `
      + race.entries.map((e) => `${e.team.short} L${e.car.race.lap} ${e.car.wheels[0].tyre.compound.slice(0, 5)} ${e.car.race.lastLap?.toFixed(1) ?? '-'}`).join('  '));
  }
  if (performance.now() - t0 > 540000) { console.log('WALL LIMIT'); break; }
}
for (const e of race.entries) {
  const i = race.entries.indexOf(e), s = stat[i], st = race.stewards.of(e);
  console.log(`${e.team.short.padEnd(5)} finish ${e.car.race.finishTime?.toFixed(1) ?? '-'} best ${e.car.race.bestLap?.toFixed(2) ?? '-'} stops ${e.strategist.stops} [${(e.strategist.decisions ?? []).length ? '' : ''}${e.stints.map((x) => x.compound ?? '').join('')}] inc ${st.inc} aqua ${(100 * s.aqua / s.n).toFixed(1)}% off ${(s.off / 120).toFixed(1)}s minVis ${s.minVis.toFixed(2)} maxSpray ${s.spray.toFixed(2)} dmg ${(e.car.damage * 100).toFixed(0)}%`);
}
console.log(`contacts ${race.contacts} severe ${race.collisionStats.severeContacts} wall ${((performance.now() - t0) / 1000).toFixed(0)}s`);
