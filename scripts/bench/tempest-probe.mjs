// Solo TEMPEST probe: prints the driver's debug every `every` seconds.
// usage: node --import ./scripts/json-loader.mjs scripts/bench/tempest-probe.mjs [track] [cls] [seconds] [every] [weather] [tyre]
import { Track } from '../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../game/core/race.js';
import { FORMATS } from '../../game/core/rules.js';
const [trackName = 'harbor-ring', cls = 'lmdh', secs = '60', every = '5', weather = 'clear', tyre = 'medium', ai = 'tempest'] = process.argv.slice(2);
const track = new Track(trackName);
const team = { id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: ai, name: ai, short: ai }], grid: 0 };
const race = new EnduranceRace({ track, teams: [team], format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, weather, seed: 7, weatherSeed: 7 });
race.start(); race.fitTyres(race.cars[0], tyre, true); race.entries[0].strategist.decide = () => null;
const c = race.cars[0], br = race.entries[0].bridges[0]; let next = 0, lap = 1;
const extra = JSON.parse(process.argv[9] ?? '{}'); race.step(FIXED_DT); if (br.driver) Object.assign(br.driver.options, extra);
while (race.time < Number(secs)) {
  race.step(FIXED_DT);
  if (c.race.lap !== lap) { console.log('LAP', c.race.lastLap.toFixed(2)); lap = c.race.lap; }
  if (process.argv.includes('--books') && race.time >= Number(secs) - FIXED_DT * 1.5) console.log(JSON.stringify(br.driver.arbiter.books()), 'recovers', br.driver.control.recovers);
  if (race.time >= next) {
    next += Number(every);
    const d = br.debug?.() ?? {};
    console.log(race.time.toFixed(1), 'v', c.speed.toFixed(1), 'tgt', d.targetSpeed?.toFixed?.(1), d.intent, d.mode, 'stab', d.stability?.toFixed?.(2), 'lap', c.race.lap, 'err', br.errors, JSON.stringify(d.plan), 'ctl', JSON.stringify(c.controls));
  }
}
if (br.lastError) console.log(br.lastError);
