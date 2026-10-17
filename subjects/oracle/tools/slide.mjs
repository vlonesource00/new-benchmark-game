// How much a car slides: solo laps of any AI, read only from the car (body slip angle, tyre slip, temperatures,
// wear), never from its code. ORACLE can be given options and a baked line file.
//   node --import ./scripts/json-loader.mjs subjects/oracle/tools/slide.mjs <ai> [cls] [track] [laps] [json-options] [lineFile]
import { readFileSync } from 'node:fs';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { carSpecFor } from '../../../game/engine/sim/car-specs.js';
import { createOracleBridge } from '../../../game/bridges/oracle-bridge.js';
import { envelope } from '../src/envelope.js';
import { Line } from '../src/line.js';

export function slideLaps({ ai = 'oracle', cls = 'gt', trackName = 'harbor-ring', laps = 4, options = {}, lineFile = '' }) {
  const track = new Track(trackName);
  if (lineFile) { const base = JSON.parse(readFileSync(lineFile, 'utf8'))[`${track.id}:${cls}`]; options = { ...options, line: new Line(track, carSpecFor(cls), envelope(cls), base, options) }; }
  const teams = [{ id: 'o', name: 'O', short: 'O', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: ai, name: ai, short: ai }], grid: 0 }];
  const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: laps + 2, startCompound: 'hard',
    ...(ai === 'oracle' ? { makeBridge: (d, i, r) => createOracleBridge({ hostTrack: r.track, index: i, options }) } : {}) });
  race.start(); race.fitTyres(race.cars[0], 'hard', true);
  for (const x of race.entries) x.strategist.decide = () => null;
  const c = race.cars[0], rows = [];
  const fresh = () => ({ t: 0, b05: 0, b10: 0, b20: 0, bMax: 0, aR: 0, aF: 0, surfMax: 0, coreMax: 0, spins: 0, inSpin: false });
  let lap = c.race.lap, m = fresh();
  while (c.race.lap <= laps && race.time < Math.max(300, track.length / 15) * laps) {
    race.step(FIXED_DT);
    if (c.speed > 8) {
      const b = Math.abs(Math.atan2(c.v, Math.max(2, c.u))), w = c.wheels;
      m.t += FIXED_DT; if (b > 0.05) m.b05 += FIXED_DT; if (b > 0.1) m.b10 += FIXED_DT; if (b > 0.2) m.b20 += FIXED_DT;
      m.bMax = Math.max(m.bMax, b);
      if (b > 0.45 && !m.inSpin) { m.spins++; m.inSpin = true; } else if (b < 0.15) m.inSpin = false;
      m.aR = Math.max(m.aR, (Math.abs(w[2].tyre.alpha) + Math.abs(w[3].tyre.alpha)) / 2); m.aF = Math.max(m.aF, (Math.abs(w[0].tyre.alpha) + Math.abs(w[1].tyre.alpha)) / 2);
      for (const x of w) { m.surfMax = Math.max(m.surfMax, x.tyre.surface); m.coreMax = Math.max(m.coreMax, x.tyre.core); }
    }
    if (c.race.lap !== lap) {
      rows.push({ lap, time: c.race.lastLap, red: c.race.lastState === 'red', ...m, wear: Math.max(...c.wheels.map((x) => x.tyre.wear)), core: c.wheels.map((x) => x.tyre.core.toFixed(0)).join('/') });
      lap = c.race.lap; m = fresh();
    }
  }
  return { rows, inc: race.stewards.of(race.entries[0]).inc };
}

if (process.argv[1]?.endsWith('slide.mjs')) {
  const [ai = 'oracle', cls = 'gt', trackName = 'harbor-ring', lapsArg = '4', opts = '{}', lineFile = ''] = process.argv.slice(2);
  const r = slideLaps({ ai, cls, trackName, laps: Number(lapsArg), options: JSON.parse(opts), lineFile });
  const pct = (x, t) => (100 * x / Math.max(1e-9, t)).toFixed(1);
  console.log(`${ai}${lineFile ? '+' + lineFile.split(/[\\/]/).pop() : ''} ${cls} ${trackName} inc ${r.inc}`);
  for (const x of r.rows) console.log(`  L${x.lap} ${x.time?.toFixed(2)}${x.red ? '!' : ''}  beta>3deg ${pct(x.b05, x.t)}% >6deg ${pct(x.b10, x.t)}% >11deg ${pct(x.b20, x.t)}% max ${(x.bMax * 57.3).toFixed(0)}deg spins ${x.spins}  peak alpha F ${(x.aF * 57.3).toFixed(1)} R ${(x.aR * 57.3).toFixed(1)}  surf ${x.surfMax.toFixed(0)} core ${x.coreMax.toFixed(0)} end ${x.core} wear ${(x.wear * 100).toFixed(1)}%`);
}
