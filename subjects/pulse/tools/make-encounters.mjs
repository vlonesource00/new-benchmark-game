import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, versions, digest } from './versions.mjs';
import { observationProfile } from '../src/observations.mjs';
import { generateEncounters } from '../src/generated-encounters.mjs';
import { generateField } from '../src/generated-field.mjs';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2), arg = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const name = arg('name'); if (!name || !/^[a-z0-9-]+$/i.test(name)) throw Error('Unique --name required');
const counts = { seed: +arg('seed', 7229), train: +arg('train', 32), development: +arg('development', 12), finalTest: +arg('final-test', 12) };
const profile = file => JSON.parse(readFileSync(resolve(HOME, 'artifacts/reference', file), 'utf8'));
const plan = arg('generator', 'arrivals-v1') === 'field-v2'
  ? generateField({ ...counts, lmdh: profile('harbor-ring-lmdh-intercept.json'), gt: profile('harbor-ring-gt-apex.json') })
  : generateEncounters(counts);
plan.name = name; plan.versions = versions(observationProfile('pulse-observation-v2').schema); plan.digest = digest(plan);
const output = resolve(HOME, 'artifacts/encounter-suites', name);
if (existsSync(output)) throw Error('Preserve the frozen encounter plan');
mkdirSync(output, { recursive: true }); writeFileSync(resolve(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
console.log(JSON.stringify({ name, counts: plan.counts, digest: plan.digest, plan: 'artifacts/encounter-suites/' + name + '/plan.json' }));
