// Solo laps for REVOLUTION through the real EnduranceRace loop.
//   node --import ./scripts/json-loader.mjs subjects/claude-revolution/tools/lap.mjs <lmdh|gt> [track] [laps] [compound] [json-options]
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT, maxWear } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { createRevolutionBridge } from '../../../game/bridges/revolution-bridge.js';

const [cls = 'lmdh', trackName = 'harbor-ring', laps = '3', compound = 'soft', opts = '{}'] = process.argv.slice(2);
const options = JSON.parse(opts);
if (process.env.LINES) options.lines = JSON.parse((await import('node:fs')).readFileSync(process.env.LINES, 'utf8'));
const track = new Track(trackName);
const teams = [{ id: 'r', name: 'R', short: 'R', color: '#fff', index: 0, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id: process.env.AI ?? 'claude-revolution', name: 'REV', short: 'REV' }], grid: 0 }];
const makeBridge = (d, i, race) => d.id === 'claude-revolution' ? createRevolutionBridge({ hostTrack: race.track, index: i, options, teamState: (car) => ({ pitPlan: race.entryOf?.(car)?.pitPlan }) }) : createSeatBridge(d, i, race);
const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: Math.max(12, Number(laps) + 1), startCompound: compound, makeBridge });
race.entries[0].team.drivers[0].kind = 'ai';
race.start(); race.fitTyres(race.cars[0], compound);
const c = race.cars[0], e = race.entries[0], drv = () => e.bridges[0].driver;
const spins = [], hist = []; let spinning = false;
let esc = 0, lap = 1, maxE = 0, maxBeta = 0, offs = 0; const rows = []; const sp = { brake: 0, drive: 0, coast: 0, front: 0, rear: 0 };
const wall = Date.now();
while (race.phase !== 'finished' && c.race.lap <= Number(laps) && race.time < Math.max(200, track.length / 20) * Number(laps)) {
  race.step(FIXED_DT);
  const d = drv(); if (d?.line) { maxE = Math.max(maxE, Math.abs(d.line.closest(c.x, c.z, d.cursor).e)); maxBeta = Math.max(maxBeta, Math.abs(Math.atan2(c.v, Math.max(2, c.u)))); }
  { const d0 = drv(); hist.push([c.s, c.speed, Math.atan2(c.v, Math.max(2, c.u)), c.yawRate, d0?.rDes, d0?.e, c.controls.throttle, c.controls.brake, c.controls.steer, c.wheels[2].tyre.kappa, c.wheels[3].tyre.kappa, c.wheels[3].tyre.alpha, d0?.targetSpeed, d0?.racecraft?.lane?.lat?.[d0.cursor]].map((x) => +(x ?? 0).toFixed(2))); if (hist.length > 200) hist.shift(); }
  { const b = Math.abs(Math.atan2(c.v, Math.max(2, c.u))); if (b > 0.35 && !spinning) { const d = drv(); if (!spins.length) console.log('s v β r rDes e thr brk str kRL kRR aRR\n' + hist.filter((_, k) => k % 10 === 0).map((h) => h.join(' ')).join('\n')); spins.push(`L${c.race.lap}@${c.s.toFixed(0)} v${c.speed.toFixed(0)} T${c.controls.throttle.toFixed(2)} B${c.controls.brake.toFixed(2)} S${c.controls.steer.toFixed(2)} ${d?.mode} stab${d?.stability?.toFixed(2)}`); } spinning = b > 0.2 ? (spinning || b > 0.35) : false; }
  if ((drv()?.stability ?? 1) < 0.9) esc += FIXED_DT;
  if (Math.abs(c.lateral) > track.halfWidth + track.curbWidth) offs += FIXED_DT;
  const pw = c.wheels.reduce((a, w) => a + w.tyre.slipPower, 0) * FIXED_DT / 1e6;
  sp[c.controls.brake > 0.05 ? 'brake' : c.controls.throttle > 0.5 ? 'drive' : 'coast'] += pw;
  sp.front += (c.wheels[0].tyre.slipPower + c.wheels[1].tyre.slipPower) * FIXED_DT / 1e6; sp.rear += (c.wheels[2].tyre.slipPower + c.wheels[3].tyre.slipPower) * FIXED_DT / 1e6;
  if (c.race.lap !== lap) { rows.push(`L${lap} ${c.wheels[0].tyre.compound[0]} ${c.race.lastLap.toFixed(2)}${c.race.lastState === 'red' ? '!' : ''} e${maxE.toFixed(1)} β${maxBeta.toFixed(2)} off${offs.toFixed(1)} esc${esc.toFixed(1)} w${(maxWear(c) * 100).toFixed(0)}% T${c.wheels.map((w) => w.tyre.core.toFixed(0)).join('/')} E b${sp.brake.toFixed(0)} d${sp.drive.toFixed(0)} c${sp.coast.toFixed(0)} F${sp.front.toFixed(0)} R${sp.rear.toFixed(0)}`); for (const k in sp) sp[k] = 0; lap = c.race.lap; esc = 0; maxE = 0; maxBeta = 0; offs = 0; }
}
const st = race.stewards.of(e);
console.log(`${cls} ${trackName} ${compound} est ${drv()?.lapEstimate?.toFixed(2)} | ${rows.join(' | ')} | inc ${st.inc}x ${st.log.map((l) => l.kind + '@' + Math.round(l.s ?? l.at ?? -1) + 'L' + (l.lap ?? '')).join(',')} spins[${spins.join('; ')}] trims ${drv()?.trims ?? 0} err ${e.bridges[0].errors} ${e.bridges[0].lastError?.slice(0, 200) ?? ''} wall ${((Date.now() - wall) / 1000).toFixed(0)}s`);
