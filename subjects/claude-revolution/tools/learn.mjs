// Pre-learns REVOLUTION's corner-usage trim: solo laps through the real race
// loop, then the learnt map is stored beside the baked line in data/lines.json.
//   node --import ./scripts/json-loader.mjs subjects/claude-revolution/tools/learn.mjs <track> <lmdh|gt> [laps] [--out=file.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { createRevolutionBridge } from '../../../game/bridges/revolution-bridge.js';

const args = process.argv.slice(2), flag = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const [id, cls, laps = '4'] = args.filter((a) => !a.startsWith('--'));
const file = flag('out') ? pathToFileURL(flag('out')) : new URL('../data/lines.json', import.meta.url);
const lines = JSON.parse(readFileSync(new URL('../data/lines.json', import.meta.url), 'utf8'));
const track = new Track(id);
const teams = [{ id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: 'claude-revolution', name: 'REV', short: 'REV' }], grid: 0 }];
const makeBridge = (d, i, race) => createRevolutionBridge({ hostTrack: race.track, index: i, options: { lines }, teamState: (car) => ({ pitPlan: race.entryOf?.(car)?.pitPlan }) });
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 12, startCompound: 'medium', makeBridge });
race.start(); race.fitTyres(race.cars[0], 'medium');
const c = race.cars[0], times = [];
while (c.race.lap <= Number(laps) && race.time < 200 * Number(laps)) { const lap = c.race.lap; race.step(FIXED_DT); if (c.race.lap !== lap) times.push(c.race.lastLap.toFixed(2)); }
const d = race.entries[0].bridges[0].driver, trim = Array.from(d.line.trim, (x) => Math.round(x * 1000) / 1000);
const out = flag('out') ? {} : lines;
(out[id] ??= {})[cls] = { ...(lines[id]?.[cls] ?? {}), trim };
writeFileSync(file, JSON.stringify(out));
console.log(`${id} ${cls} laps ${times.join(' ')} trims ${d.trims ?? 0} min ${Math.min(...trim).toFixed(3)} max ${Math.max(...trim).toFixed(3)}`);
