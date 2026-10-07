// Debugger probe: runs a small race and samples APEX's debug() / visualDebug() as the in-game lens would, checking that
// every number is finite, the payload stays small, and that reading it never changes the race (run with and without).
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/dbgprobe.mjs [ids=next-racer,next-racer,apex] [cls=lmdh] [track=solenne] [seconds=60] [json-apex-options] [--probe=0|1] [--show=1]
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { createApexBridge, apexState } from '../../../game/bridges/apex-bridge.js';
import { lensModel } from '../../../game/ui/lens-model.js';

const pos = process.argv.slice(2).filter((a) => !a.startsWith('--')), flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [idsArg = 'next-racer,next-racer,apex', cls = 'lmdh', trackName = 'solenne', secs = '60', opts = '{"combatMode":"pass"}'] = pos;
const ids = idsArg.split(','), options = JSON.parse(opts), track = new Track(trackName), probe = flags.probe !== '0';
const short = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
const teams = ids.map((id, i) => ({ id: 't' + i, name: short(id) + i, short: short(id) + i, color: '#fff', index: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id, name: id, short: short(id) }], grid: i }));
const makeBridge = (d, i, race) => d.id === 'apex' ? createApexBridge({ hostTrack: race.track, index: i, options, state: (car) => apexState(race, car) }) : createSeatBridge(d, i, race);
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, startCompound: 'medium', makeBridge, startType: 'rolling', seed: 7 });
for (const e of race.entries) e.strategist.decide = () => null;
race.start(); for (const c of race.cars) race.fitTyres(c, 'medium', true);
const me = ids.indexOf('apex'), e = race.entries[me], bridge = e.bridges[0];
// --lens=1: also run the 3D lens (game/render/ai-lens.js) against stub canvases, to prove it draws without errors and within its buffers
let lens = null, lensMax = { tris: 0, lines: 0 }, lensErrors = 0;
if (flags.lens) {
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }) }) };
  const THREE = await import('three'), { AiLens } = await import('../../../game/render/ai-lens.js');
  lens = new AiLens(new THREE.Scene());
}
let samples = 0, bad = 0, maxBytes = 0, show = null; const seen = {}, kinds = {};
const walk = (o, path) => { if (typeof o === 'number') { if (!Number.isFinite(o)) { bad++; if (bad < 6) console.log('NON-FINITE', path); } } else if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], path + '.' + k); };
while (race.time < Number(secs)) {
  race.step(FIXED_DT);
  if (probe && race.greenAt != null && Math.round(race.time * 120) % 30 === 0) {
    const dbg = bridge.debug(), vis = bridge.visualDebug();
    walk(dbg, 'debug'); walk(vis, 'vis'); samples++;
    const bytes = JSON.stringify(dbg).length + JSON.stringify(vis).length; maxBytes = Math.max(maxBytes, bytes);
    seen[dbg.intent] = (seen[dbg.intent] ?? 0) + 1;
    const m = lensModel(race, me, 'apex', dbg, vis);
    if (lens) { try { lens.update(race, me, true, bridge, m, 'APX'); lensMax.tris = Math.max(lensMax.tris, lens.tris.geometry.drawRange.count); lensMax.lines = Math.max(lensMax.lines, lens.lines.geometry.drawRange.count); } catch (err) { lensErrors++; if (lensErrors < 3) console.log('LENS ERROR', err.stack.split('\n').slice(0, 3).join(' | ')); } }
    kinds[m.focus?.kind ?? 'none'] = (kinds[m.focus?.kind ?? 'none'] ?? 0) + 1;
    if (flags.show && !show && (dbg.intent === 'ATTACK' || dbg.intent === 'ALONGSIDE') && vis.extras?.rivals?.length) show = { t: race.time, dbg, vis, model: { ...m, extras: undefined } };
    if (flags.dump && (dbg.intent === 'ATTACK' || dbg.intent === 'ALONGSIDE') && vis.extras?.rivals?.length >= 2 && !globalThis.__dumped) { globalThis.__dumped = 1; const { writeFileSync } = await import('node:fs'); writeFileSync(flags.dump, JSON.stringify({ t: race.time, names: Object.fromEntries(race.cars.map((c, k) => [c.id, race.entries[k].team.short])), model: m })); }
  }
}
const car = race.cars[me];
console.log(JSON.stringify({ lens: lens ? { errors: lensErrors, ...lensMax } : null, probe, samples, bad, maxBytes, intents: seen, focusKinds: kinds, finalS: Math.round(car.race.progress), v: +car.speed.toFixed(3), x: +car.x.toFixed(3), z: +car.z.toFixed(3), laps: car.race.lap, inc: race.stewards.of(e).points ?? null, stats: bridge.driver?.combat?.stats }));
if (show) console.log('SHOW', JSON.stringify(show, null, 1).slice(0, 6000));
