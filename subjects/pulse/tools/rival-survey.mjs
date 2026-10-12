// Rival stability survey: same placed train scenes, INTERCEPT reference in the
// PULSE seat, each candidate rival AI in the GT seats. Counts rival departures
// (speed < 7 or > halfWidth + .8 laterally) — the scenes' hazard rule.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME } from './versions.mjs';
import { runScenario } from './scenario.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const rival = arg('rival'), name = arg('name'), limit = +arg('cases', 12);
const out = resolve(HOME, 'artifacts/rival-survey', `${name}-${rival}.json`);
if (!rival || !name || existsSync(out)) throw Error('--name and --rival required; outputs are never overwritten');
const plan = JSON.parse(readFileSync(resolve(HOME, arg('plan', 'artifacts/encounter-suites/c107-generated-arrivals/plan.json')), 'utf8'));
const cases = plan.cases.filter(c => c.split === 'train' && c.settings.fixture === 'train').slice(0, limit);
const rows = [];
for (const c of cases) {
  const s = { ...c.settings, rival, mode: 'teacher', seconds: 60 };
  for (const k of ['frameSteps', 'lagFrames', 'lagJitter', 'frameJitter', 'scheduleSeed', 'replyServiceMs', 'transport']) delete s[k];
  const { summary: r } = await runScenario(s);
  rows.push({ case: c.id, departures: r.rivals.reduce((n, x) => n + x.departures.length, 0), rivals: r.rivals,
    refPasses: r.retainedPasses, refDamage: r.cumulativeDamage, progress: r.progress });
  console.log(JSON.stringify({ case: c.id, departures: rows.at(-1).departures, refPasses: r.retainedPasses, refDamage: +r.cumulativeDamage.toFixed(4) }));
}
const total = rows.reduce((n, r) => n + r.departures, 0), rivalCount = rows.reduce((n, r) => n + r.rivals.length, 0);
writeFileSync(out, JSON.stringify({ rival, cases: rows.length, departures: total, departureRate: total / rivalCount,
  rivalDamage: rows.flatMap(r => r.rivals.map(x => x.damage)).reduce((a, b) => a + b, 0) / rivalCount, rows }, null, 2) + '\n');
console.log(JSON.stringify({ rival, departures: total, rivalCount, refPasses: rows.reduce((n, r) => n + r.refPasses, 0) }));
