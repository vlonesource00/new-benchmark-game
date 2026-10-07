// Dev harness: solo APEX laps with a history dump at the first incidents.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/lap.mjs <lmdh|gt> [track] [laps] [compound] [json-options]
// env: HIST=n samples shown (default 60, every 6th step), EVENTS=n incident dumps (default 2)
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT, maxWear } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createApexBridge, apexState } from '../../../game/bridges/apex-bridge.js';
import { createSeatBridge } from '../../../game/core/field.js';

const [cls = 'lmdh', trackName = 'harbor-ring', laps = '3', compound = 'medium', opts = '{}'] = process.argv.slice(2);
const options = JSON.parse(opts), n = Number(laps), track = new Track(trackName);
const team = { id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: 'apex', name: 'APEX', short: 'APX' }], grid: 0 };
// FRAME=n emulates a seat worker: the driver sees the state every n physics steps (dt = n/120) and its answer is applied one such frame later.
const FRAME = Number(process.env.FRAME ?? 1);
const makeBridge = (d, i, race) => {
  const b = createApexBridge({ hostTrack: race.track, index: i, options, state: (car) => apexState(race, car) });
  if (FRAME <= 1) return b;
  let tick = 0, pending = null, applied = null;
  const update = b.update.bind(b);
  b.update = (car, cars, dt, ctx) => {
    if (tick++ % FRAME === 0) { applied = pending; update(car, cars, FRAME / 120, ctx); pending = { ...car.controls }; if (!applied) applied = pending; }
    car.controls = { ...applied };
  };
  return b;
};
const race = new EnduranceRace({ track, teams: [team], format: { ...FORMATS.custom, mandatoryStops: process.env.STOP ? 1 : 0, mandatorySwap: false }, laps: process.env.STOP ? Number(laps) + 1 : 30, startCompound: compound, makeBridge });
race.start(); race.fitTyres(race.cars[0], compound);
const e = race.entries[0], c = race.cars[0], drv = () => e.bridges[0].driver;
if (!process.env.STOP) e.strategist.decide = () => null;
const hist = [], HIST = Number(process.env.HIST ?? 60), EVENTS = Number(process.env.EVENTS ?? 2);
let lap = 1, shown = 0, logN = 0; const rows = []; let maxE = 0, offs = 0, vsum = 0, vn = 0;
const t0 = Date.now();
while (c.race.lap <= n && race.time < Math.max(400, track.length / 6) * n) {
  race.step(FIXED_DT);
  if (process.env.REARGRIP) for (const w of [c.wheels[2], c.wheels[3]]) w.tyre.gripScale = 1 * Number(process.env.REARGRIP);
  if (process.env.FRONTGRIP) for (const w of [c.wheels[0], c.wheels[1]]) w.tyre.gripScale = 1 * Number(process.env.FRONTGRIP);
  const d = drv();
  if (race.time > 0.5) {
    maxE = Math.max(maxE, Math.abs(d?.e ?? 0));
    if (Math.abs(c.lateral) > track.halfWidth + track.curbWidth) offs += FIXED_DT;
    if (Math.round(race.time * 120) % 6 === 0) hist.push([race.time, c.s, c.speed, d?.targetSpeed, c.controls.steer, Math.atan2(c.v, Math.max(2, c.u)), d?.e, c.controls.throttle, c.controls.brake, c.yawRate, d?.stability, c.lateral, c.wheels[0].tyre.alpha, c.wheels[2].tyre.alpha, c.wheels[2].tyre.kappa, c.ay, d?.ayReq, d?.latCap, c.wheels[0].tyre.core, d?.model?.grip].map((x) => +(x ?? 0).toFixed(2)));
    if (hist.length > HIST) hist.shift();
    if (process.env.ONSET && Math.abs(d?.dBeta ?? 0) > Number(process.env.ONSET) && c.speed > 15 && race.time - (globalThis.__last ?? -9) > 6 && shown < EVENTS) { globalThis.__last = race.time; shown++; console.log(`ONSET dBeta ${d.dBeta.toFixed(2)} lap ${c.race.lap}\n t s v tv steer beta e thr brk yawR stab lat aF aR kR ay ayReq cap coreF grip\n` + hist.map((h) => h.join(' ')).join('\n')); }
    const log = race.stewards.of(e).log.length;
    if (log > logN) { logN = log; if (shown++ < EVENTS) console.log(`EVENT ${race.stewards.of(e).log.at(-1).kind} lap ${c.race.lap}\n t s v tv steer beta e thr brk yawR stab lat aF aR kR ay ayReq cap coreF grip\n` + hist.map((h) => h.join(' ')).join('\n')); }
  }
  if (c.race.lap !== lap) { rows.push(`L${lap} ${c.race.lastLap.toFixed(2)}${c.race.lastState === 'red' ? '!' : ''} e${maxE.toFixed(1)} off${offs.toFixed(1)} w${(maxWear(c) * 100).toFixed(0)}% T${c.wheels.map((w) => w.tyre.core.toFixed(0)).join('/')} est${drv()?.lapEstimate?.toFixed(1)}`); lap = c.race.lap; maxE = 0; offs = 0; }
}
const st = race.stewards.of(e);
if (process.env.STOP) console.log(race.events.filter((x) => ['pit', 'strategy', 'swap', 'penalty', 'incident'].includes(x.type)).map((x) => `${x.time.toFixed(1)} ${x.text}`).join('\n'));
console.log(`${cls} ${trackName} ${compound} | ${rows.join(' | ')} | inc ${st.inc}x [${st.log.map((l) => l.kind).slice(0, 8).join(',')}] err ${e.bridges[0].errors} ${e.bridges[0].lastError?.slice(0, 300) ?? ''} wall ${((Date.now() - t0) / 1000).toFixed(0)}s`);
