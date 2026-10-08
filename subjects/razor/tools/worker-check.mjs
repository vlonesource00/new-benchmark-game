// The game's real worker transport, with matching-cadence opponents and an
// attacks-disabled counterfactual. This catches chassis-specific prediction
// regressions that a native controller or a successful ATTACK label misses.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hz = Number(process.argv.find(a => a.startsWith('--hz='))?.split('=')[1] ?? 30);
assert.ok([20, 30, 60].includes(hz));
const cases = [
  { name: 'GTP against RAZOR', args: ['razor', 'lmdh'] },
  { name: 'GTP against APEX', args: ['apex', 'lmdh'] },
  { name: 'GTP through GT3', args: ['apex', 'lmdh', 'gt'] },
  { name: 'GT3 against RAZOR', args: ['razor', 'gt'] }
];
const results = [];
for (const setup of cases) {
  const run = spawnSync(process.execPath, ['--import', './scripts/json-loader.mjs',
    'subjects/razor/tools/worker-encounters.mjs', ...setup.args, `--hz=${hz}`, '--require-move'],
  { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  let row;
  try { row = JSON.parse(run.stdout); } catch { /* Diagnostics below include the original error. */ }
  const passed = run.status === 0 && row?.moveDemonstrated && row.enabled.contacts === 0
    && row.enabled.rivalOff === 0;
  const result = { name: setup.name, hz, passed: Boolean(passed),
    pass: row?.enabled.passedAt, controlPass: row?.control.passedAt,
    contacts: row?.enabled.contacts, hard: row?.enabled.severe,
    off: row?.enabled.off, rivalOff: row?.enabled.rivalOff,
    replies: row?.enabled.replies, replyAge: row?.enabled.replyAgeP95 };
  if (!passed) result.error = run.error?.message ?? run.stderr.trim();
  results.push(result); console.log(JSON.stringify(result));
}
assert.ok(results.every(r => r.passed), 'Every worker matchup must stay clean and execute a causal pass');
console.log(JSON.stringify({ passed: results.length, hz }));
