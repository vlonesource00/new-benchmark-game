// Solo ORACLE laps through the real race loop.
//   node --import ./scripts/json-loader.mjs subjects/oracle/tools/lap.mjs <gt|lmdh> [track] [laps] [compound] [json-options]
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT, maxWear } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createOracleBridge } from '../../../game/bridges/oracle-bridge.js';

export async function soloLaps({ cls, trackName, laps, compound, options, onStep = null }) {
  const track = new Track(trackName);
  const teams = [{ id: 'o', name: 'O', short: 'O', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: 'oracle', name: 'ORC', short: 'ORC' }], grid: 0 }];
  const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: Math.max(12, laps + 2), startCompound: compound,
    makeBridge: (d, i, r) => createOracleBridge({ hostTrack: r.track, index: i, options }) });
  race.start(); race.fitTyres(race.cars[0], compound, options?.cold ? false : true); // warm, as the race fields fit them
  for (const x of race.entries) x.strategist.decide = () => null;
  const c = race.cars[0], e = race.entries[0], st = () => race.stewards.of(e);
  const rows = []; let lap = c.race.lap, off = 0, maxE = 0, maxB = 0;
  while (c.race.lap <= laps && race.time < Math.max(300, track.length / 15) * laps) {
    race.step(FIXED_DT);
    const d = e.bridges[0].driver;
    if (d?.trace) { maxE = Math.max(maxE, Math.abs(d.trace.e)); maxB = Math.max(maxB, Math.abs(d.trace.beta)); }
    if (Math.abs(c.lateral) > track.halfWidth + track.curbWidth) off += FIXED_DT;
    onStep?.(c, d, race);
    if (c.race.lap !== lap) { rows.push({ lap, time: c.race.lastLap, state: c.race.lastState, off, maxE, maxB, wear: maxWear(c) }); lap = c.race.lap; off = 0; maxE = 0; maxB = 0; }
  }
  return { rows, inc: st().inc, errors: e.bridges[0].errors, lastError: e.bridges[0].lastError, car: c, race };
}
if (process.argv[1]?.endsWith("lap.mjs")) {
  const [cls = 'gt', trackName = 'harbor-ring', laps = '3', compound = 'soft', opts = '{}'] = process.argv.slice(2), options = JSON.parse(opts);
  const wall = Date.now();
  const r = await soloLaps({ cls, trackName, laps: Number(laps), compound, options });
  console.log(`${cls} ${trackName} ${compound} | ${r.rows.map((x) => `L${x.lap} ${x.time?.toFixed(2)}${x.state === 'red' ? '!' : ''} e${x.maxE.toFixed(1)} b${x.maxB.toFixed(2)} off${x.off.toFixed(1)}`).join(' | ')} | inc ${r.inc} err ${r.errors} ${r.lastError?.slice(0, 300) ?? ''} wall ${((Date.now() - wall) / 1000).toFixed(1)}s`);
}
