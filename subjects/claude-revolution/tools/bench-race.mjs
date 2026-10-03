// Multiclass race bench: GTP and GT3 entries per AI, rolling start, real
// stewards and strategy. Reports finishing order, incidents and best laps.
//   node --import ./scripts/json-loader.mjs subjects/claude-revolution/tools/bench-race.mjs [track] [laps] [ai,ai,...]
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';

const [trackName = 'harbor-ring', laps = '8', list = 'claude-revolution,solstice,gemini-supreme-v4'] = process.argv.slice(2);
const ais = list.split(','), track = new Track(trackName);
const short = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
const teams = [];
for (const cls of ['lmdh', 'gt']) for (const id of ais) {
  const i = teams.length;
  teams.push({ id: `t${i}`, name: `${short(id)}-${cls}`, short: `${short(id)}${cls === 'gt' ? 'g' : 'p'}`, color: '#fff', index: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id, name: id, short: short(id) }], grid: i });
}
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: Number(laps), startCompound: 'medium', makeBridge: createSeatBridge, startType: 'rolling' });
race.start();
const wall = Date.now();
while (race.phase !== 'finished' && race.time < 120 * Number(laps) + 120) race.step(FIXED_DT);
const rows = race.entries.map((e) => ({ e, c: e.car })).sort((a, b) => b.c.race.progress - a.c.race.progress);
for (const cls of ['lmdh', 'gt']) {
  console.log(cls === 'lmdh' ? 'GTP' : 'GT3');
  rows.filter((r) => r.c.classId === cls).forEach((r, k) => {
    const st = race.stewards.of(r.e);
    console.log(`  P${k + 1} ${r.e.team.short.padEnd(5)} laps ${r.c.race.lap - 1} best ${r.c.race.bestLap?.toFixed(2)} stops ${r.e.strategist.stops} inc ${st.inc}x [${st.log.map((l) => l.kind).join(',')}] err ${r.e.bridges[0].errors}`);
  });
}
console.log(`time ${race.time.toFixed(0)} s · wall ${((Date.now() - wall) / 1000).toFixed(0)} s`);
