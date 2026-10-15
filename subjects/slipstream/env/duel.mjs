// duel3 combat benchmark: 24 two-lap Nürburgring races (env/racecraft.mjs), SLIPSTREAM held on the grid 3..13 s behind
// four rival trios, run 6 at a time at below-normal priority. Prints one summary line for viewer/bench-add.mjs:
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/duel.mjs <label> [policy export.json | -] [outDir]
// policy: the candidate's export, raced directly (the deployed policy files are never touched); '-' = deployed weights.
// Per-race JSON lines go to outDir/<label>-<k>.jsonl (default: the OS temp dir).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setPriority, constants, tmpdir } from 'node:os';
import { join } from 'node:path';

const [label, policy = '-', outDir = tmpdir()] = process.argv.slice(2);
if (!label || !/^[a-z0-9-]+$/i.test(label)) { console.error('usage: duel.mjs <label> [policy|-] [outDir]'); process.exit(2); }
const HOLDS = [3, 5, 7, 9, 11, 13], RIVALS = ['intercept,intercept,intercept', 'intercept,razor,intercept', 'razor,intercept,intercept', 'intercept,intercept,razor'];
const jobs = HOLDS.flatMap((h) => RIVALS.map((rv) => ({ h, rv }))).map((j, i) => ({ ...j, k: i + 1 }));

const run = ({ h, rv, k }) => new Promise((res, rej) => {
  const out = join(outDir, `${label}-${k}.jsonl`), chunks = [];
  const p = spawn(process.execPath, ['--import', './scripts/json-loader.mjs', 'subjects/slipstream/env/racecraft.mjs', 'nurburgring', 'slipstream', rv, '2', String(k), '-', 'standing', String(h), policy], { stdio: ['ignore', 'pipe', 'inherit'] });
  try { setPriority(p.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
  p.stdout.on('data', (c) => chunks.push(c));
  p.on('close', (code) => { const txt = Buffer.concat(chunks).toString('utf8'); writeFileSync(out, txt); const line = txt.split('\n').find((l) => l.startsWith('{'));
    return code === 0 && line ? res(JSON.parse(line)) : rej(new Error(`race ${k} exited ${code}`)); });
});

const R = new Array(jobs.length); let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => { while (next < jobs.length) { const j = jobs[next++]; R[j.k - 1] = await run(j); } }));
const s = (k) => R.reduce((a, r) => a + (r[k] || 0), 0), med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const P = R.flatMap((r) => r.passList.filter((p) => p.t > 15)), seps = P.map((p) => p.sepM), clr = R.map((r) => r.minClrM).filter((x) => x !== null);
console.log(`duel3 ${label}`, 'meanPos', (s('finishPos') / R.length).toFixed(2), 'wins', R.filter((r) => r.finishPos === 1).length, 'gained', s('gained'),
  'passes', s('passes'), 'clean', s('cleanPasses'), 'lost', s('passedBy'), 'stuckS', s('stuckS').toFixed(0), 'rubS', s('rubS').toFixed(1),
  'heavy', R.reduce((a, r) => a + r.incLog.filter((l) => l[1] === 'contact').length, 0), 'otherInc', R.reduce((a, r) => a + r.incLog.filter((l) => l[1] !== 'contact').length, 0),
  'dmg', s('damage').toFixed(2), 'offS', s('offS').toFixed(1), 'invalid', s('invalidLaps'), 'impactMax', Math.max(...R.map((r) => r.maxImpact)).toFixed(1),
  'clrMed', med(clr)?.toFixed(2) ?? null, 'tookMed', med(P.map((p) => p.took)), 'sep<3', seps.filter((x) => x < 3).length + '/' + seps.length,
  'unfinished', R.filter((r) => !r.finished).length,
  // contact seconds by geometry (nose: ran into a car ahead; tail: hit from behind; side: alongside), and races with an off
  'nose/tail/side', ['nose', 'tail', 'side'].map((k) => R.reduce((a, r) => a + (r.rubKinds?.[k] ?? 0), 0).toFixed(1)).join('/'),
  'offRaces', R.filter((r) => r.offS > 0).length);
