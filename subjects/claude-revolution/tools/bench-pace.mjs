// Solo stint: lap times until the first stop, fade = slowest racing lap before the in-lap minus best.
//   node --import ./scripts/json-loader.mjs subjects/claude-revolution/tools/bench-pace.mjs <ai> <lmdh|gt> [track] [laps]
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT, maxWear } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
const [ai, cls, trackName = 'harbor-ring', laps = '12'] = process.argv.slice(2);
const track = new Track(trackName);
const raceClass = cls === 'lmdh' ? 'gtp' : 'gt3';
const teams = [{ id: 'p', name: 'P', short: 'P', color: '#fff', index: 0, starter: 0, classId: cls, raceClass, drivers: [{ kind: 'ai', id: ai, name: ai, short: 'P' }], grid: 0 }];
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: Number(laps) });
race.start(); const c = race.cars[0], e = race.entries[0];
const out = []; let lap = 1, firstStop = null, comp = c.wheels[0].tyre.compound;
while (race.phase !== 'finished' && race.time < 1200) {
  race.step(FIXED_DT);
  if (e.pit && firstStop === null) firstStop = c.race.lap;
  if (c.race.lap !== lap) { out.push({ t: c.race.lastLap, w: maxWear(c), pit: e.lapHadPit || c.race.pitLap }); lap = c.race.lap; }
}
const stint = out.slice(1, (firstStop ?? out.length + 1) - 1); // flying laps before the in-lap
const best = Math.min(...stint.map((l) => l.t)), worst = Math.max(...stint.map((l) => l.t));
console.log(`${ai.padEnd(18)} ${cls.padEnd(5)} ${trackName} ${comp} stop@${firstStop ?? '-'} best ${best.toFixed(2)} fade ${(worst - best).toFixed(2)} inc ${race.stewards.of(e).inc}x | ${out.map((l) => l.t.toFixed(1)).join(' ')}`);
