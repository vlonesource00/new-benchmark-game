// One-screen summary of duel.mjs output files (--json=1 [--contacts=N]).   node subjects/apex/tools/duelsum.mjs <file> [file...]
import { readFileSync } from 'node:fs';
for (const file of process.argv.slice(2)) {
  const text = readFileSync(file, 'utf8'), lines = text.split('\n');
  console.log(`== ${file.split('/').pop()}`);
  for (const l of lines.filter((x) => x.startsWith('CONTACT'))) console.log('  ' + l.slice(0, 300));
  const js = lines.filter((x) => x.startsWith('{')).at(-1);
  if (!js) { console.log('  (no result line)', lines.slice(-2).join(' | ').slice(0, 300)); continue; }
  const j = JSON.parse(js), me = j.ids.indexOf('apex');
  console.log('  takeovers', JSON.stringify(j.takeovers.map((t) => ({ t: t.t, r: t.rival, dir: t.dir === 'apex-ahead' ? '+' : '-', lap: t.lap, edge: t.speedEdge6s, st: t.state, tag: t.tag }))));
  console.log('  ' + j.rows.map((r) => `${r.name} gap ${r.gap} best ${r.best?.toFixed(2)} inc ${r.inc}${r.kinds?.length ? ' [' + r.kinds.join(',') + ']' : ''} dmg ${r.dmg}`).join(' | '), `| contacts ${j.contacts} peak ${j.peakClosing} sev ${j.severe}`);
  j.combat?.forEach((c, i) => { if (c) console.log(`  ${j.ids[i]}${i} stats ${JSON.stringify(c.stats)}${c.cost ? ` plan ${c.cost.n} avg ${(c.cost.total / c.cost.n).toFixed(2)} ms max ${c.cost.max.toFixed(1)} ms` : ''}`); });
}
