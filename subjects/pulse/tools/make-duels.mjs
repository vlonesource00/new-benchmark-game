// Same-pace duel suite (src/generated-duels.mjs) as an encounter plan for plan-evaluate and the GPU scene bank.
//   node tools/make-duels.mjs --name duel-v1 [--seed 7301 --train 160 --development 30 --final-test 12]
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, versions, digest } from './versions.mjs';
import { observationProfile } from '../src/observations.mjs';
import { generateDuels } from '../src/generated-duels.mjs';
const args = process.argv.slice(2), arg = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const name = arg('name'); if (!name || !/^[a-z0-9-]+$/i.test(name)) throw Error('Unique --name required');
const counts = { seed: +arg('seed', 7301), train: +arg('train', 160), development: +arg('development', 30), finalTest: +arg('final-test', 12) };
const plan = generateDuels({ ...counts, lmdh: JSON.parse(readFileSync(resolve(HOME, 'artifacts/reference/harbor-ring-lmdh-intercept.json'), 'utf8')) });
plan.name = name; plan.versions = versions(observationProfile('pulse-observation-v2').schema); plan.digest = digest(plan);
const output = resolve(HOME, 'artifacts/encounter-suites', name);
if (existsSync(output)) throw Error('Preserve the frozen encounter plan');
mkdirSync(output, { recursive: true }); writeFileSync(resolve(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
console.log(JSON.stringify({ name, counts: plan.counts, digest: plan.digest, plan: 'artifacts/encounter-suites/' + name + '/plan.json' }));
