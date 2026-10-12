// Preserve exact execution sources beside each experiment. A source digest
// alone cannot replay an uncommitted controller after the next edit.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, ROOT, digest } from './versions.mjs';

export function archiveExecution(output) {
  const files = ['src/plan-executor.mjs', 'src/plan-contract.mjs', 'src/course-arc.mjs', 'src/runtime.mjs',
    'src/seat-timing.mjs', 'tools/scenario.mjs', 'tools/drive-cases.mjs', 'tools/archive-execution.mjs',
    'tools/probe-route-execution.mjs', 'tools/probe-plan-contract.mjs', 'tools/plan-evaluate.mjs', 'tools/search-plans.mjs'];
  const directory = resolve(output, 'execution-source'); mkdirSync(directory, { recursive: true });
  const sources = {};
  for (const file of files) {
    const text = readFileSync(resolve(HOME, file), 'utf8'), path = file.replaceAll('/', '__');
    writeFileSync(resolve(directory, path), text); sources[file] = { path: 'execution-source/' + path, sha256: digest(text) };
  }
  const lock = readFileSync(resolve(ROOT, 'package-lock.json'), 'utf8');
  const manifest = { format: 'pulse-execution-source-v1', sources, packageLockDigest: digest(lock) };
  writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { manifest: 'execution-source/manifest.json', digest: digest(manifest) };
}
