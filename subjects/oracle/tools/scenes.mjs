// The VANGUARD combat screen (subjects/vanguard/tools/combat-bench.mjs: 18 short encounters through the real async-seat
// protocol, deterministic) run on ORACLE with ORACLE options, one child process per scene, plus ORACLE's own move log
// and an optional per-frame trace of one scene.
//   node --import ./scripts/json-loader.mjs subjects/oracle/tools/scenes.mjs [json] [--only a,b] [--trace scene] [--seconds 40]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

if (args[0] === '--case') {
  const c = JSON.parse(args[1]), { OracleDriver } = await import('../src/driver.js');
  const u0 = OracleDriver.prototype.update, seen = new Set();
  let me = null, clock = 0, next = 0;
  OracleDriver.prototype.update = function (car, cars, dt, ...x) {
    if (!this.isShadow && !seen.has(this)) { seen.add(this); Object.assign(this.options, c.oracle); me = this; }
    const out = u0.call(this, car, cars, dt, ...x);
    if (this === me && c.trace) {
      clock += dt;
      if (clock >= next) {
        next = clock + 0.1;
        const cb = this.combat, mv = cb?.mv, v = cb?.vis, rv = [...(cb?.rivals?.values() ?? [])][0], ctl = out?.throttle != null ? out : car.controls;
        console.log(`tr ${clock.toFixed(1)} s ${this.loc?.s.toFixed(0)} ${this.mode ?? ''} ${mv?.kind ?? ''}${mv?.kind === 'MOVE' ? (mv.dive ? ':dive' : mv.early ? ':pass' : ':pull') + (mv.side > 0 ? 'R' : 'L') : ''} e ${(this.loc?.e ?? 0).toFixed(1)} lane ${(this.lateral ?? cb?.lane ?? 0).toFixed(1)} v ${car.speed.toFixed(1)} thr ${(ctl?.throttle ?? 0).toFixed(2)} brk ${(ctl?.brake ?? 0).toFixed(2)} | r gap ${rv?.gap?.toFixed(1)} e ${rv?.e?.toFixed(1)} v ${rv?.car?.speed?.toFixed(1)} | cap ${cb?.capBy ? 'Y' : '-'} tb ${v?.tb?.toFixed?.(1) ?? '-'} free ${v?.free ?? '-'} why ${v?.whyNot ?? cb?.whyNot ?? '-'} bad ${(mv?.bad ?? 0).toFixed(2)} k ${(this.line.sample(this.line.k, this.loc.i, this.loc.f) * 1000).toFixed(1)} err ${(this.trace_?.he ?? 0).toFixed(3)} catch ${this.catching ? 1 : 0} rs ${((Math.abs(car.wheels[2].tyre.alpha) + Math.abs(car.wheels[3].tyre.alpha)) / 2).toFixed(3)} fs ${((Math.abs(car.wheels[0].tyre.alpha) + Math.abs(car.wheels[1].tyre.alpha)) / 2).toFixed(3)} lv ${(this.laneV ?? 0).toFixed(2)} ay ${car.ay?.toFixed(1)}${rv && cb?.line ? (() => { const L = cb.line, q = L.locate(rv.car.x, rv.car.z, rv.hint), q2 = L.locate(car.x, car.z, -1); return ` | rat ${rv.ratio.toFixed(3)} pR ${L.sample(L.v, q.i, q.f).toFixed(1)} pMe ${L.sample(L.v, q2.i, q2.f).toFixed(1)} acc ${rv.acc.toFixed(1)} vel ${Number.isNaN(rv.vel[q.i]) ? '-' : rv.vel[q.i].toFixed(1)}`; })() : ''}`);
      }
    }
    return out;
  };
  process.on('exit', () => { if (me?.combat?.mv) console.log('MV ' + JSON.stringify({ n: me.combat.mv.n, ev: me.combat.mv.ev ?? [] })); });
  process.argv = [process.argv[0], process.argv[1], '--run', JSON.stringify({ driver: 'oracle', scene: c.scene, seed: c.seed, options: {} })];
  await import('../../vanguard/tools/combat-bench.mjs');
} else {
  // The scene list is read from the bench's source (importing it would run the bench's own screen).
  const { readFileSync } = await import('node:fs'), src = readFileSync(new URL('../../vanguard/tools/combat-bench.mjs', import.meta.url), 'utf8');
  const combatCases = Function('return ' + src.slice(src.indexOf('[', src.indexOf('export const combatCases')), src.indexOf('];', src.indexOf('export const combatCases')) + 1))();
  const oa = args.find((a) => a.startsWith('{') || a.startsWith('@')) ?? '{}', oracle = JSON.parse(oa[0] === '@' ? readFileSync(oa.slice(1), 'utf8') : oa), only = flag('only', '').split(',').filter(Boolean), traced = flag('trace', '');
  const seconds = Number(flag('seconds', 40)), self = fileURLToPath(import.meta.url), cwd = fileURLToPath(new URL('../../../', import.meta.url));
  const rows = [];
  for (const sc of combatCases.filter((x) => !only.length || only.includes(x.id))) {
    const scene = { ...sc, duration: seconds, ...(!sc.doors && ['equal', 'momentum', 'traffic'].includes(sc.kind) ? { attackGap: 14 } : {}) };
    const mvLog = oracle.mvLog || traced === sc.id;
    const r = spawnSync(process.execPath, ['--import', './scripts/json-loader.mjs', self, '--case', JSON.stringify({ scene, seed: 7, oracle: { ...oracle, mvLog }, trace: traced === sc.id })], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
    const lines = (r.stdout ?? '').split('\n');
    if (traced === sc.id) for (const l of lines) if (l.startsWith('tr ')) console.log(l);
    const res = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x?.scene === sc.id);
    const mv = lines.find((l) => l.startsWith('MV ')), m = mv ? JSON.parse(mv.slice(3)) : null;
    if (mvLog && m) for (const e of m.ev) console.log(`  ev ${sc.id} ${e}`);
    if (!res) { console.log(sc.id, 'ERROR', (r.stderr ?? '').slice(-400)); continue; }
    const s = res.score ?? {}, row = { id: sc.id, ok: Boolean(s.success), clean: Boolean(s.cleanPass || s.cleanDefence), contacts: res.contacts, dmg: res.ego.damage * 100, gap: res.finalGap, n: m?.n };
    rows.push(row);
    console.log(`${sc.id.padEnd(22)} ${row.ok ? 'OK ' : '-- '}${row.clean ? 'clean' : '     '} ct ${String(row.contacts).padStart(3)} dmg ${row.dmg.toFixed(1).padStart(4)} gap ${row.gap.toFixed(1).padStart(7)}${m ? ' mv ' + JSON.stringify(m.n) : ''}${res.contacts ? ` ctAt ${[...new Set((res.contactEvents ?? []).map((x) => x.t.toFixed(0)))].join(',')} kinds ${JSON.stringify(res.contactKinds)}` : ''}`);
  }
  const att = rows.filter((x) => !/defend|brake/.test(x.id)), def = rows.filter((x) => /defend/.test(x.id)), brk = rows.filter((x) => /brake/.test(x.id));
  console.log(`attack ${att.filter((x) => x.ok).length}/${att.length} (clean ${att.filter((x) => x.clean).length}) defend ${def.filter((x) => x.ok).length}/${def.length} brake ${brk.filter((x) => x.ok).length}/${brk.length}`);
}
