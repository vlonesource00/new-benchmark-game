// Solo wet pace: one AI alone for N laps on a chosen tyre in a chosen weather; lap times, tyre cores, road wetness
// under the car, aquaplaning share. Compares against the same run in the dry when weather=both.
// usage: node --import ./scripts/json-loader.mjs scripts/weather/solo-wet.mjs [ai=razor] [tyre=wet] [weather=rain] [track=harbor-ring] [laps=3] [cls=lmdh]
import { Track } from '../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../game/core/race.js';
import { FORMATS } from '../../game/core/rules.js';

const [ai = 'razor', tyre = 'wet', weather = 'rain', trackName = 'harbor-ring', lapsArg = '3', cls = 'lmdh'] = process.argv.slice(2);
const laps = Number(lapsArg);
function run(wx) {
  const track = new Track(trackName);
  const team = { id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: ai, name: ai, short: ai }], grid: 0 };
  const race = new EnduranceRace({ track, teams: [team], format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, weather: wx, seed: 7, weatherSeed: 7 });
  race.start(); race.fitTyres(race.cars[0], tyre, true); race.entries[0].strategist.decide = () => null;
  const c = race.cars[0], out = []; let lap = 1, n = 0, aq = 0, wet = 0, core = 0;
  while (c.race.lap <= laps && race.time < laps * 200) {
    race.step(FIXED_DT); n++;
    if (c.wheels.some((w) => w.aqua > 0.3)) aq++;
    const p = track.nearest(c.x, c.z); wet += track.wetAt(p.index, track.laneAt(p.lateral)); core += c.wheels.reduce((a, w) => a + w.tyre.core, 0) / 4;
    if (c.race.lap !== lap) { out.push(`${c.race.lastLap.toFixed(2)}`); lap = c.race.lap; }
  }
  const wd = race.entries[0].bridges[0].driver?.water?.debug?.(); if (wd) console.log('water', JSON.stringify(wd));
  return `${wx.padEnd(10)} ${tyre} laps ${out.join(' ')} | road ${track.wetness.toFixed(2)} under-car ${(wet / n).toFixed(2)} core ${(core / n).toFixed(0)}C aqua ${(100 * aq / n).toFixed(1)}% off ${c.zone}`;
}
for (const wx of weather === 'both' ? ['clear', 'rain'] : [weather]) console.log(run(wx));
