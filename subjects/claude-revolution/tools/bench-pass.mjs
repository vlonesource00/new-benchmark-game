// Pass anatomy: was each REVOLUTION pass a racecraft move or just its line pace?
// Runs the rival solo for a reference speed trace, then a rolling-start duel with
// REVOLUTION behind, and dissects every completed pass.
//   node --import ./scripts/json-loader.mjs subjects/claude-revolution/tools/bench-pass.mjs <rival-ai> [lmdh|gt] [track] [laps] [compound] [own-compound]
// Env: TRACE=1|move (following trace), SECT=1 (gap change per 50 m), INCH=1 (history before an incident).
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { AI_DRIVERS } from '../../../game/core/teams.js';

const [rival = 'solstice', cls = 'lmdh', trackName = 'harbor-ring', laps = '4', compound = 'medium', ownCompound = compound] = process.argv.slice(2);
const track = new Track(trackName), L = track.length, BIN = 5, NB = Math.ceil(L / BIN);
const name = (id) => AI_DRIVERS.find((d) => d.id === id)?.short ?? id;
const team = (id, i) => ({ id: `t${i}`, name: `${name(id)}${i}`, short: `${name(id)}${i}`, color: '#fff', index: i, starter: 0, classId: cls, raceClass: cls === 'lmdh' ? 'gtp' : 'gt3', drivers: [{ kind: 'ai', id, name: id, short: name(id) }], grid: i });
const mk = (ids, start) => { const r = new EnduranceRace({ track, teams: ids.map(team), format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 12, startCompound: compound, makeBridge: createSeatBridge, ...(start ? { startType: start } : {}) }); r.start(); for (const c of r.cars) r.fitTyres(c, compound, true); return r; };

// Reference: rival alone, lap 2 speed by 5 m bin.
const ref = new Float64Array(NB).fill(NaN);
{ const r = mk([rival]), c = r.cars[0]; while (c.race.lap <= 2 && r.time < 300) { r.step(FIXED_DT); if (c.race.lap === 2) ref[Math.floor(c.s / BIN) % NB] = c.speed; } }

const race = mk([rival, 'claude-revolution'], 'rolling'), [a, b] = race.cars;
race.fitTyres(b, ownCompound, true);
const drv = () => race.entries[1].bridges[0].driver;
const hist = [], out = [];
let order = Math.sign(a.race.progress - b.race.progress);
const esc = { follow: 0, followEsc: 0, solo: 0, soloEsc: 0, wakeSum: 0 };
const eng = { close: 0, attack: 0, starts: 0, minGap: Infinity, wake: 0, prev: 'line' };
while (race.phase !== 'finished' && Math.min(a.race.lap, b.race.lap) <= Number(laps) && race.time < 90 * Number(laps) + 60) {
  race.step(FIXED_DT);
  if (race.formation) continue;
  const d = drv(), rc = d?.racecraft; if (!d?.line) continue;
  const line = d.line, ci = d.cursor, path = rc.lane ?? line;
  const rv = ref[Math.floor(a.s / BIN) % NB];
  hist.push({ t: race.time, ds: a.race.progress - b.race.progress, s: b.s, vA: a.speed, vB: b.speed, rvDef: Number.isFinite(rv) ? rv - a.speed : 0,
    kind: rc.kind, state: rc.state, laneOff: path.lat[ci] - line.lat[ci], bOff: line.closest(b.x, b.z, ci).e, aOff: line.closest(a.x, a.z, -1).e,
    k: line.ks[ci], brk: b.controls.brake, inc: race.stewards.of(race.entries[0]).log.length });
  if (hist.length > 1200) hist.shift();
  { const n = race.stewards.of(race.entries[1]).log.length; if (n > (globalThis.__ninc ?? 0)) { globalThis.__ninc = n; const r = rc.rivals.map.get(a.id); console.log(`  INC ${race.stewards.of(race.entries[1]).log.at(-1).kind} L${b.race.lap} s${b.s.toFixed(0)} v${b.speed.toFixed(1)} lat${b.lateral.toFixed(1)} fwd${r?.fwd?.toFixed(1)} ${rc.kind}/${rc.state} move${rc.move ? JSON.stringify({ side: rc.move.side, dir: rc.move.dir }) : '-'} laneOff${(path.lat[ci] - line.lat[ci]).toFixed(1)} stab${d.stability?.toFixed(2)}`); if (process.env.INCH) console.log(hist.slice(-240).filter((_, k) => k % 12 === 0).map((h) => `    s${h.s.toFixed(0)} ds${h.ds.toFixed(1)} vB${h.vB.toFixed(1)} vA${h.vA.toFixed(1)} ${h.kind}/${h.state} lane${h.laneOff.toFixed(1)} bOff${h.bOff.toFixed(1)} brk${h.brk.toFixed(2)}`).join(String.fromCharCode(10))); } }
  { const r = rc.rivals.map.get(a.id), f = r && r.fwd > 0 && r.fwd < 40, low = (d.stability ?? 1) < 0.9; if (f) { esc.follow += FIXED_DT; if (low) esc.followEsc += FIXED_DT; esc.wakeSum += (b.aero?.wake ?? 0) * FIXED_DT; } else if (!r || Math.abs(r.fwd) > 100) { esc.solo += FIXED_DT; if (low) esc.soloEsc += FIXED_DT; } }
  if (process.env.SECT) { const r = rc.rivals.map.get(a.id), k = Math.floor(b.s / 50); if (r && r.fwd > 0 && r.fwd < 45 && !a.pit?.active) { const S = (globalThis.__sect ??= {}); const e = (S[k] ??= { n: 0, d: 0, v: 0, vb: 0, last: null }); if (e.last !== null && e.lk === race.time - FIXED_DT) e.d += r.fwd - e.last; e.last = r.fwd; e.lk = race.time; e.n++; e.v += line.v[ci]; e.vb += b.controls.brake; } }
  { const r = rc.rivals.map.get(a.id); if (process.env.TRACE && r && (process.env.TRACE === 'move' ? rc.move : r.fwd > 0 && r.fwd < 60) && Math.round(race.time * 60) % 6 === 0) console.log(`s${b.s.toFixed(0)} fwd${r?.fwd?.toFixed(1)} vA${a.speed.toFixed(1)} vB${b.speed.toFixed(1)} wake${b.aero?.wake?.toFixed(2)} draft${rc.draft ? 1 : 0} cap${rc.cap?.toFixed?.(1)} tgt${d.targetSpeed.toFixed(1)} thr${b.controls.throttle.toFixed(2)} brk${b.controls.brake.toFixed(2)} ${rc.kind} rfx${rc.reflexCap?.toFixed?.(1)} laneV${path.v[ci].toFixed(1)} stab${d.stability?.toFixed(2)} nudge${rc.nudge.toFixed(2)} blk${rc.blocker ?? "-"} [${rc.cands}] latA${a.lateral.toFixed(1)} latB${b.lateral.toFixed(1)}`); }
  { const g = (a.race.progress - b.race.progress) / Math.max(1, b.speed); // time gap while behind
    if (g > 0 && !a.pit?.active && a.race.lap === b.race.lap || g > 0 && g < 3) {
      if (g < 1) eng.close += FIXED_DT; eng.minGap = Math.min(eng.minGap, g); if (b.aero?.wake > 0.3) eng.wake += FIXED_DT;
      const att = rc.kind !== 'line' && Math.abs(path.lat[ci] - line.lat[ci]) > 1;
      if (att) eng.attack += FIXED_DT; if (att && eng.prev !== 'att') eng.starts++; eng.prev = att ? 'att' : 'line'; } }
  const dd = a.race.progress - b.race.progress, o = Math.sign(dd);
  if (o !== order && Math.abs(dd) > 6) {
    order = o;
    if (o > 0) { out.push(`  re-passed by ${name(rival)} L${a.race.lap} s${a.s.toFixed(0)}`); continue; }
    // Window: from CRV within 15 m behind to completion.
    let k0 = hist.length - 1; while (k0 > 0 && hist[k0 - 1].ds < 15 && hist[k0 - 1].ds > -7) k0--;
    const w = hist.slice(k0), over = w.reduce((m, h) => (Math.abs(h.ds) < Math.abs(m.ds) ? h : m));
    const moveT = w.filter((h) => h.kind !== 'line' && Math.abs(h.laneOff) > 1).length * FIXED_DT;
    const maxLane = Math.max(...w.map((h) => Math.abs(h.laneOff)));
    const kinds = [...new Set(w.map((h) => h.kind))].join('/'), states = [...new Set(w.map((h) => h.state))].join('/');
    const rivDef = Math.max(...w.map((h) => h.rvDef)), rivInc = w.at(-1).inc > w[0].inc;
    const blocking = Math.abs(over.aOff) < 2.2;  // rival sitting on CRV's line at the overlap
    const why = rivInc || rivDef > 6 ? 'RIVAL MISTAKE/SLOW' : moveT > 0.5 && maxLane > 1.5 ? 'RACECRAFT MOVE' : 'LINE PACE (no move)';
    out.push(`  PASS L${b.race.lap} s${over.s.toFixed(0)} ${why} · window ${(w.at(-1).t - w[0].t).toFixed(1)}s · CRV off-line lane ${moveT.toFixed(1)}s max ${maxLane.toFixed(1)}m [${kinds}] states[${states}] · at overlap: CRV off ${over.bOff.toFixed(1)}m, ${name(rival)} off CRV-line ${over.aOff.toFixed(1)}m${blocking ? ' (ON our line)' : ''}, dv ${(over.vB - over.vA).toFixed(1)} m/s, ${Math.abs(over.k) > 0.004 ? 'corner' : 'straight'}${over.brk > 0.05 ? ' braking' : ''} · rival below its solo speed by max ${rivDef.toFixed(1)} m/s${rivInc ? ' +incident' : ''}`);
  }
}
if (process.env.SECT) console.log(Object.entries(globalThis.__sect).sort((x, y) => x[0] - y[0]).map(([k, e]) => `${k * 50}:${e.d.toFixed(1)}${e.vb / e.n > 0.2 ? 'B' : ''}`).join(' '));
console.log(`  ESC: following ${(100 * esc.followEsc / Math.max(1, esc.follow)).toFixed(1)}% of ${esc.follow.toFixed(0)} s (mean wake ${(esc.wakeSum / Math.max(1, esc.follow)).toFixed(2)}) · clear ${(100 * esc.soloEsc / Math.max(1, esc.solo)).toFixed(1)}% of ${esc.solo.toFixed(0)} s`);
{ const rc = drv()?.racecraft; console.log(`  moves ${rc?.moves ?? 0} · completed ${rc?.passes ?? 0} · aborted ${rc?.aborts ?? 0}`); }
console.log(`  behind: <1 s gap ${eng.close.toFixed(1)} s · in wake ${eng.wake.toFixed(1)} s · off-line attack ${eng.attack.toFixed(1)} s in ${eng.starts} tries · min gap ${eng.minGap.toFixed(2)} s`);
console.log(`${name(rival)} ahead of CRV · ${cls} ${trackName} ${compound}\n${out.join('\n') || '  no pass'}\n  final gap ${(b.race.progress - a.race.progress).toFixed(0)} m · inc ${race.entries.map((e) => race.stewards.of(e).log.map((l) => l.kind).join(",") || "-").join(" / ")} · best ${a.race.bestLap?.toFixed(2)} / ${b.race.bestLap?.toFixed(2)}`);
