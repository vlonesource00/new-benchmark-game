import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, digest } from './versions.mjs';
import { driveCases } from './drive-cases.mjs';
const args = process.argv.slice(2), arg = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const name = arg('name'), model = arg('model'), path = arg('plan'), split = arg('split', 'development');
if (!path || !['train', 'development', 'final-test'].includes(split)) throw Error('Frozen --plan and valid --split required');
if (split === 'final-test' && !args.includes('--frozen-candidate')) throw Error('Final test requires --frozen-candidate after development selection; results must never guide tuning');
const plan = JSON.parse(readFileSync(resolve(HOME, path), 'utf8')), { digest: expected, ...content } = plan;
if (plan.format !== 'pulse-generated-encounters-v1' || digest(content) !== expected) throw Error('Generated encounter plan was altered');
const cases = plan.cases.filter(c => c.split === split);
const report = await driveCases({ name, model, cases, provenance: { plan: path, planDigest: expected, role: split, sourceVersions: plan.versions,
  finalTestRule: plan.finalTestRule, selectionMetric: 'Physical admissibility plus all required retained passes/clearances; then measured progress and lap times.' } });
console.log(JSON.stringify({ name, accepted: report.accepted, succeeded: report.succeeded, total: cases.length }));
