import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SCHEMA } from '../src/schema.mjs';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const HOME = fileURLToPath(new URL('../', import.meta.url));
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function treeDigest(directories) {
  const files = [];
  const walk = path => { if (!statSync(path).isDirectory()) { files.push(path); return; } for (const name of readdirSync(path)) { const child = resolve(path, name); if (statSync(child).isDirectory()) walk(child); else if (/\.(js|mjs|json)$/.test(name)) files.push(child); } };
  for (const dir of directories) walk(resolve(ROOT, dir));
  files.sort();
  const hash = createHash('sha256');
  for (const path of files) hash.update(relative(ROOT, path).replaceAll('\\', '/')).update('\0').update(readFileSync(path)).update('\0');
  return hash.digest('hex');
}
export function versions(schema = SCHEMA) {
  if (!['pulse-observation-v1', 'pulse-observation-v2'].includes(schema.version)) throw Error('Unknown observation contract');
  return { schemaVersion: schema.version, schemaDigest: digest(schema),
    simulatorDigest: treeDigest(['game/core', 'game/engine/sim']),
    observationDigest: treeDigest(['subjects/pulse/src/schema.mjs', ...(schema.version === 'pulse-observation-v2' ? ['subjects/pulse/src/schema-v2.mjs'] : [])]),
    harnessDigest: treeDigest(['subjects/pulse/src/runtime.mjs', 'subjects/pulse/src/observations.mjs',
      'subjects/pulse/tools/scenario.mjs', 'subjects/pulse/tools/record.mjs', 'subjects/pulse/tools/policy.mjs']),
    teacherDigest: treeDigest(['subjects/intercept/src', 'subjects/intercept/config.json']),
    git: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), teacher: 'intercept' };
}
