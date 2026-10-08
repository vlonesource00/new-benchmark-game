import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
for (const { laps, compound, oneStop } of [
  { laps: 12, compound: 'hard', oneStop: true },
  { laps: 20 }
]) {
  const args = ['--import', './scripts/json-loader.mjs', 'subjects/razor/tools/race.mjs',
    'razor,apex', 'gt', String(laps), 'clear', '7'];
  if (compound) args.push(compound);
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 40000 });
  assert.equal(result.status, 0, result.stderr);
  const race = JSON.parse(result.stdout), razor = race.rows.find(r => r.id === 'razor');
  assert.ok(Number.isFinite(razor.finish));
  assert.ok(razor.errors.every(n => n === 0));
  assert.equal(race.severe, 0);
  assert.ok(!razor.incidents.some(kind => /off track|wall|loss of control|recovery/i.test(kind)), JSON.stringify(razor.incidents));
  assert.ok(razor.swaps >= 1);
  if (oneStop) assert.equal(razor.stops, 1, 'Do not choose a long soft finish, then add repeated window stops');
  console.log(JSON.stringify({ laps, passed: true, contacts: race.contacts,
    rows: race.rows.map(r => ({ id: r.id, finish: +r.finish.toFixed(2), stops: r.stops, incidents: r.incidents })) }));
}
