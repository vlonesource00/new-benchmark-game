// Reference driver (teacher mode, full control) on a generated suite: checks
// that scenes are achievable and gives a ceiling. Never runs final-test.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME } from './versions.mjs';
import { runScenario } from './scenario.mjs';
import { encounterOutcome, RACE_DAMAGE_OBJECTIVE } from '../src/encounter-outcomes.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name'), split = arg('split', 'development'), shard = +arg('shard', 0), shards = +arg('shards', 1), limit = +arg('limit', 1e9);
if (!name || split === 'final-test') throw Error('--name required; final-test is sealed');
const out = resolve(HOME, 'artifacts/reference-suites', `${name}-${shard}.json`);
if (existsSync(out)) throw Error('Preserve reference results');
mkdirSync(resolve(HOME, 'artifacts/reference-suites'), { recursive: true });
const plan = JSON.parse(readFileSync(resolve(HOME, arg('plan')), 'utf8'));
const cases = plan.cases.filter(c => c.split === split).slice(0, limit).filter((_, i) => i % shards === shard), rows = [];
for (const c of cases) {
  const s = { ...c.settings, mode: 'teacher' };
  for (const k of ['frameSteps', 'lagFrames', 'lagJitter', 'frameJitter', 'scheduleSeed', 'replyServiceMs', 'transport']) delete s[k];
  const result = await runScenario(s), sm = result.summary;
  const o = encounterOutcome(result, { seconds: s.seconds, checkpointDistance: c.checkpointDistance, objective: RACE_DAMAGE_OBJECTIVE });
  const req = Object.entries(c.requirements).filter(([k, m]) => { const v = k === 'validFullLaps' ? sm.fullLaps.filter(l => l.valid).length : sm[k];
    return !(k === 'unpassedTraffic' ? v <= m : v >= m); }).map(([k, m]) => k);
  rows.push({ id: c.id, family: c.family, admissible: o.admissible, failures: o.failures, req, ok: o.admissible && !req.length,
    passes: sm.retainedPasses, hazards: sm.hazardsCleared, unpassed: sm.unpassedTraffic, damage: sm.cumulativeDamage,
    checkpoint: o.checkpointSeconds, bestLap: sm.bestFullLap, departures: sm.rivals.reduce((n, r) => n + r.departures.length, 0) });
  console.log(JSON.stringify(rows.at(-1)));
}
writeFileSync(out, JSON.stringify({ plan: arg('plan'), split, shard, shards, rows }, null, 2) + '\n');
