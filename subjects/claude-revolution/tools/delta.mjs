// Solo time delta around a lap: REVOLUTION against another AI (lap 2, same compound).
//   node --import ./scripts/json-loader.mjs subjects/claude-revolution/tools/delta.mjs [rival] [lmdh|gt] [track] [compound]
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';

const [rival = 'solstice', cls = 'lmdh', trackName = 'harbor-ring', compound = 'medium'] = process.argv.slice(2);
const track = new Track(trackName), L = track.length, BIN = 10, NB = Math.ceil(L / BIN);
const lap = (id) => {
  const race = new EnduranceRace({ track, teams: [{ id: 't', name: id, short: id, color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id, name: id, short: id }], grid: 0 }], format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 12, startCompound: compound, makeBridge: createSeatBridge });
  race.start(); const c = race.cars[0]; race.fitTyres(c, compound, true);
  const t = new Float64Array(NB).fill(NaN), v = new Float64Array(NB).fill(NaN); let t0 = null;
  while (c.race.lap <= 2 && race.time < 300) { race.step(FIXED_DT); if (c.race.lap === 2) { t0 ??= race.time; const b = Math.floor(c.s / BIN) % NB; if (!Number.isFinite(t[b])) { t[b] = race.time - t0; v[b] = c.speed; } } }
  return { t, v, lap: c.race.lastLap };
};
const a = lap('claude-revolution'), b = lap(rival);
console.log(`lap CRV ${a.lap.toFixed(2)} ${rival} ${b.lap.toFixed(2)} · delta (+ = CRV behind) every 100 m, with speeds`);
const rows = [];
for (let k = 0; k < NB; k += 10) rows.push(`${k * BIN}:${(a.t[k] - b.t[k]).toFixed(2)}(${a.v[k].toFixed(0)}/${b.v[k].toFixed(0)})`);
console.log(rows.join(' '));
