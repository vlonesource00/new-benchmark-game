// Prints the matched traffic-bench rows for result files: node subjects/counterpoint/tools/summary.mjs <prefix>...
import { readFileSync, readdirSync } from 'node:fs';
const dir = new URL('../results/', import.meta.url);
for (const prefix of process.argv.slice(2)) {
  const rows = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
  const subs = rows.flatMap((r) => r.subjects.map((s) => ({ ...s, seed: r.seed })));
  const mean = (k) => subs.reduce((a, s) => a + (s[k] ?? NaN), 0) / subs.length;
  console.log(`${prefix.padEnd(18)} n=${subs.length} finish ${mean('timeFromGreen').toFixed(2)} best ${mean('bestLap').toFixed(2)} stuck ${mean('stuckSeconds').toFixed(1)} passes ${mean('retainedPasses').toFixed(2)} dmg ${(100 * mean('damage')).toFixed(1)}% inc ${mean('incidents').toFixed(1)} off ${mean('offtrackSeconds').toFixed(2)} sev ${mean('severe').toFixed(1)} rubs ${mean('mildRubs').toFixed(1)} done ${subs.filter((s) => s.completed).length}/${subs.length} wall ${(rows.reduce((a, r) => a + r.wallSeconds, 0) / rows.length).toFixed(0)}s`);
  for (const s of subs) console.log(`   seed ${s.seed} pos ${s.position} t ${s.timeFromGreen?.toFixed(2)} stuck ${s.stuckSeconds.toFixed(1)} dmg ${(100 * s.damage).toFixed(1)} inc ${s.incidents} invalid ${s.invalidations.length}`);
}
