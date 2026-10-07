// Prints markdown tables from data/baseline.json (reference AIs) for RESULTS.md.
import { readFileSync } from 'node:fs';
const b = JSON.parse(readFileSync(new URL('../data/baseline.json', import.meta.url), 'utf8'));
const ais = ['next-racer', 'solstice', 'claude-revolution', 'apex'], tag = { 'next-racer': 'SPH', solstice: 'SLC', 'claude-revolution': 'CRV', apex: 'APX' };
const names = { 'harbor-ring': 'Harbor Ring', solenne: 'Solenne', alpine: 'Alpine', desert: 'Desert', nurburgring: 'Nürburgring' };
console.log('| Track | Class | ' + ais.filter((a) => Object.values(b).some((t) => Object.values(t).some((c) => c[a]))).map((a) => `${tag[a]} best / mean`).join(' | ') + ' |');
const used = ais.filter((a) => Object.values(b).some((t) => Object.values(t).some((c) => c[a])));
console.log('|---|---|' + used.map(() => '---').join('|') + '|');
for (const t of Object.keys(names)) for (const c of ['lmdh', 'gt']) {
  const row = b[t]?.[c]; if (!row) continue;
  console.log(`| ${names[t]} | ${c === 'lmdh' ? 'GTP' : 'GT3'} | ` + used.map((a) => row[a] ? `${row[a].best?.toFixed(2)} / ${row[a].mean?.toFixed(2)}${row[a].inc ? ` (${row[a].inc}x)` : ''}` : '-').join(' | ') + ' |');
}
