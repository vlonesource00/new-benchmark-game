import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function provenance() {
  const root = fileURLToPath(new URL('../../../', import.meta.url)), files = [];
  function gather(relative) {
    if (!existsSync(root + relative)) return;
    for (const entry of readdirSync(root + relative, { withFileTypes: true })) {
      const file = relative + '/' + entry.name;
      if (entry.isDirectory()) gather(file);
      else if (/\.(m?js|json)$/.test(file)) files.push(file);
    }
  }
  for (const dir of ['game/core', 'game/bridges', 'game/engine/sim', 'scripts/bench',
    ...['counterpoint', 'vanguard', 'vanguard-v2', 'apex', 'intercept', 'razor', 'oracle', 'tempest', 'solstice', 'next-racer']
      .flatMap(id => [`subjects/${id}/src`, `subjects/${id}/data`]), 'subjects/counterpoint/tools', 'subjects/vanguard/tools']) gather(dir);
  for (const id of ['vanguard', 'vanguard-v2', 'apex', 'intercept', 'razor', 'oracle', 'tempest', 'solstice', 'next-racer']) {
    const file = `subjects/${id}/config.json`; if (existsSync(root + file)) files.push(file);
  }
  const sourceHashes = Object.fromEntries([...new Set(files)].sort().map(file => [file,
    createHash('sha256').update(readFileSync(root + file)).digest('hex')]));
  return { fingerprint: createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex'), sourceHashes, node: process.version };
}
