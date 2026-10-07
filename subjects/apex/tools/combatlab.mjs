// Combat lab: does APEX pass because of what it does, or only because it is faster?
// APEX's margin is tuned (and cached) so that its solo best lap equals the rival's best lap times (1 + delta); it then starts
// behind two copies of the rival. Every scenario is run twice on the same seed: with the pass planner (combatMode "pass") and
// as the control (combatMode "cap": rear-end cap and alongside guard only, no moves). A pass is credited to a move only when
// the planner had an attack lane out within 4 s of it (APEX's own bookkeeping) and the speed edge over the previous 6 s is
// reported with it, so a pass that needed three metres per second of pace is visible as that.
//   node --import ./scripts/json-loader.mjs subjects/apex/tools/combatlab.mjs [--vs next-racer,claude-revolution] [--tracks solenne]
//        [--classes lmdh] [--deltas 0,-0.005] [--laps 3] [--seeds 7] [--jobs 3] [--compound medium] [--opts '{}'] [--out file.json]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const list = (k, d) => String(flag(k, d)).split(',').filter(Boolean);
const vs = list('vs', 'next-racer'), tracks = list('tracks', 'solenne'), classes = list('classes', 'lmdh'), deltas = list('deltas', '0,-0.005').map(Number);
const laps = flag('laps', '3'), seeds = list('seeds', '7'), jobs = Number(flag('jobs', 3)), compound = flag('compound', 'medium'), extra = JSON.parse(flag('opts', '{}')), out = flag('out', null);
const base = JSON.parse(readFileSync(new URL('../data/baseline.json', import.meta.url), 'utf8'));
const cacheFile = new URL('../data/match.json', import.meta.url), cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
const solo = fileURLToPath(new URL('./solo.mjs', import.meta.url)), duel = fileURLToPath(new URL('./duel.mjs', import.meta.url));
const short = { 'next-racer': 'SPH', 'claude-revolution': 'CRV', solstice: 'SLC' };

const run = (file, argv) => new Promise((resolve) => {
  const p = spawn('node', ['--import', './scripts/json-loader.mjs', file, ...argv], { stdio: ['ignore', 'pipe', 'ignore'] });
  let b = ''; p.stdout.on('data', (d) => { b += d; }); p.on('close', () => { try { resolve(JSON.parse(b.trim().split('\n').filter((x) => x.startsWith('{')).at(-1))); } catch { resolve(null); } });
});

async function match(track, cls, rival, delta) {
  const key = `${track}|${cls}|${rival}|${delta}`;
  if (cache[key]) return cache[key];
  const target = base[track]?.[cls]?.[rival]?.best * (1 + delta); if (!target) return null;
  let lo = 0.6, hi = 0.995, best = { margin: hi, solo: Infinity };
  for (let k = 0; k < 8; k++) {
    const m = +((lo + hi) / 2).toFixed(4), r = await run(solo, ['apex', cls, track, '3', 'medium', JSON.stringify({ margin: m, combatMode: 'cap' })]), t = r?.best ?? Infinity;
    if (Math.abs(t - target) < Math.abs(best.solo - target)) best = { margin: m, solo: t };
    if (t > target) lo = m; else hi = m;
  }
  cache[key] = { ...best, target }; writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
  return cache[key];
}

const scenarios = [];
for (const t of tracks) for (const c of classes) for (const r of vs) for (const d of deltas) for (const s of seeds) scenarios.push({ t, c, r, d, s });
const results = []; let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < scenarios.length) {
    const sc = scenarios[next++], mt = await match(sc.t, sc.c, sc.r, sc.d);
    if (!mt) { results.push({ ...sc, error: 'no baseline' }); continue; }
    const row = { ...sc, margin: mt.margin, solo: mt.solo, target: mt.target };
    for (const mode of ['cap', 'pass']) {
      const j = await run(duel, [`${sc.r},${sc.r},apex`, sc.c, sc.t, laps, JSON.stringify({ ...extra, margin: mt.margin, combatMode: mode }), '--json=1', `--seed=${sc.s}`, `--compound=${compound}`]);
      if (!j) { row[mode] = null; continue; }
      const me = j.rows.findIndex((x) => x.ai === 'apex'), cb = j.combat[j.ids.indexOf('apex')] ?? null, st = cb?.stats ?? {};
      row[mode] = {
        place: me + 1, of: j.rows.length, gap: j.rows[me].gap, inc: j.rows[me].inc, dmg: j.rows[me].dmg, rivalInc: j.rows.filter((x) => x.ai !== 'apex').reduce((a, x) => a + x.inc, 0),
        passes: j.takeovers.filter((x) => x.dir === 'apex-ahead'), lost: j.takeovers.filter((x) => x.dir === 'rival-ahead').length,
        contacts: j.contacts, severe: j.severe, peak: j.peakClosing, movePasses: st.movePasses ?? 0, pacePasses: st.pacePasses ?? 0, attacks: st.attacks ?? 0, attackWins: st.attackWins ?? 0, cost: cb?.cost ?? null
      };
    }
    results.push(row); console.error(`done ${sc.t} ${sc.c} ${short[sc.r] ?? sc.r} d${sc.d} s${sc.s}: control P${row.cap?.place} passes ${row.cap?.passes.length} | planner P${row.pass?.place} passes ${row.pass?.passes.length} (move ${row.pass?.movePasses}) lost ${row.pass?.lost} inc ${row.pass?.inc}`);
  }
}));

results.sort((a, b) => `${a.t}${a.c}${a.r}${a.d}${a.s}`.localeCompare(`${b.t}${b.c}${b.r}${b.d}${b.s}`));
const fmt = (m) => m ? `P${m.place}/${m.of} gap ${m.gap} m | passes ${m.passes.length} [${m.passes.map((x) => `L${x.lap}@${x.s} edge ${x.speedEdge6s} ${x.state ?? ''}${x.tag ? '/' + x.tag : ''}`).join('; ')}] move ${m.movePasses} pace ${m.pacePasses} lost ${m.lost} | attacks ${m.attacks} won ${m.attackWins} | contacts ${m.contacts} peak ${m.peak} severe ${m.severe} inc ${m.inc} (rivals ${m.rivalInc})` : 'FAILED';
const tot = { cap: { passes: 0, move: 0, pace: 0, lost: 0, inc: 0, severe: 0, contacts: 0, place: 0, n: 0, attacks: 0, wins: 0 }, pass: { passes: 0, move: 0, pace: 0, lost: 0, inc: 0, severe: 0, contacts: 0, place: 0, n: 0, attacks: 0, wins: 0 } };
for (const o of results) {
  if (o.error) { console.log(o.t, o.c, o.r, o.error); continue; }
  console.log(`${o.t} ${o.c} vs ${short[o.r] ?? o.r} δ${(o.d * 100).toFixed(1)}% seed ${o.s} margin ${o.margin} (solo ${o.solo?.toFixed(2)} vs ${o.target.toFixed(2)})\n    control  ${fmt(o.cap)}\n    planner  ${fmt(o.pass)}`);
  for (const mode of ['cap', 'pass']) { const m = o[mode], t = tot[mode]; if (!m) continue; t.n++; t.passes += m.passes.length; t.move += m.movePasses; t.pace += m.pacePasses; t.lost += m.lost; t.inc += m.inc; t.severe += m.severe; t.contacts += m.contacts; t.place += m.place; t.attacks += m.attacks; t.wins += m.attackWins; }
}
for (const mode of ['cap', 'pass']) { const t = tot[mode]; console.log(`SUMMARY ${mode === 'cap' ? 'control' : 'planner'}: scenarios ${t.n} passes ${t.passes} (move ${t.move}, pace ${t.pace}) lost ${t.lost} attacks ${t.attacks} won ${t.wins} mean place ${(t.place / Math.max(1, t.n)).toFixed(2)} APEX incident points ${t.inc} severe ${t.severe} contacts ${t.contacts}`); }
if (out) writeFileSync(out, JSON.stringify(results, null, 1));
