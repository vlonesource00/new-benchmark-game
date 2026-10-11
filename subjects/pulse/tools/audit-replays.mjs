// Review every recorded replay without turning archived failures into promotion evidence.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, digest } from './versions.mjs';
import { lineReview } from '../src/body-geometry.mjs';
import { replayKind } from '../src/replay-kind.mjs';
const args = process.argv.slice(2), i = args.indexOf('--name'), name = args[i + 1];
if (i < 0 || !/^[a-z0-9-]+$/i.test(name)) throw Error('New audit name required');
const output = resolve(HOME, 'artifacts/replay-audits', name);
if (existsSync(output)) throw Error('Preserve prior audits');
mkdirSync(output, { recursive: true });
const report = { name, createdAt: new Date().toISOString(), episodes: [], groups: {},
  scope: 'Retrospective replay audit. Summary legality/damage comes from 120 Hz execution; line diagnostics use saved sampled rows. Historical trials, expert runs and fitted NN runs are distinguished. No new performance certification.' };
const files = readdirSync(resolve(HOME, 'results')).filter(x => x.endsWith('.json')).sort();
for (let n = 0; n < files.length; n++) {
  const file = files[n], bytes = readFileSync(resolve(HOME, 'results', file)), result = JSON.parse(bytes);
  const { manifest: m, summary: s, rows } = result;
  if (!m || !s || !rows?.length) throw Error('Incomplete replay: ' + file);
  const kind = replayKind(m, s);
  const line = lineReview(rows, result.track.halfWidth);
  const violations = [];
  if (!['trackLimitSeconds', 'cumulativeDamage', 'severe', 'minFuel', 'seconds', 'missingRows', 'expertActuatorRows', 'expertRows'].every(k => Number.isFinite(s[k]))) violations.push('missing-summary-evidence');
  if (s.trackLimitSeconds > 0) violations.push('track');
  if (s.cumulativeDamage > 1e-8) violations.push('damage');
  if (s.severe > 0) violations.push('severe-field-contact');
  if (s.dq || s.endedEarly || s.seconds < m.settings.seconds - 1e-6) violations.push('incomplete');
  if (s.minFuel < 1) violations.push('fuel');
  if (s.missingRows || s.expertActuatorRows || s.expertRows) violations.push('missing/assisted');
  const wear0 = rows[0].before.tyres, wear1 = rows.at(-1).post.tyres;
  const item = { name: file.slice(0, -5), group: file.match(/^c\d+/)?.[0] ?? 'archive', kind,
    model: m.policy?.training?.out ?? m.policy?.architecture ?? null, modelSha256: m.policy?.modelSha256 ?? null,
    fixture: s.fixture, track: s.track, classId: s.classId, seconds: s.seconds,
    settings: m.settings, sourceDigest: digest(bytes.toString()), versions: m.versions,
    violations, zeroDamageLegal: violations.length === 0, damage: s.cumulativeDamage, fieldSevere: s.severe,
    trackLimitSeconds: s.trackLimitSeconds, asphaltEdgeSeconds: s.asphaltEdgeSeconds,
    retained: s.retainedPasses, encounters: s.encounters, bestFullLap: s.bestFullLap,
    fullLaps: s.fullLaps, progress: s.progress, wearSpent: Math.max(...wear1.map((t, i) => t.wear - wear0[i].wear)),
    line, replay: '/?episode=' + file.slice(0, -5) };
  report.episodes.push(item);
  const key = item.group + '/' + kind, group = report.groups[key] ??= { count: 0, clean: 0, illegal: 0, damaged: 0 };
  group.count++; group.clean += +item.zeroDamageLegal; group.illegal += +(s.trackLimitSeconds > 0); group.damaged += +(s.cumulativeDamage > 1e-8);
  if (n % 50 === 0) console.log(JSON.stringify({ audited: n + 1, total: files.length }));
}
writeFileSync(resolve(output, 'report.json'), JSON.stringify(report));
const byModel = new Map();
for (const e of report.episodes.filter(e => e.kind === 'fitted-NN')) {
  const key = e.model ?? 'unknown', m = byModel.get(key) ?? { model: key, runs: 0, clean: 0, illegal: 0, damaged: 0, clearFrontCorrections: 0 };
  m.runs++; m.clean += +e.zeroDamageLegal; m.illegal += +(e.trackLimitSeconds > 0); m.damaged += +(e.damage > 1e-8);
  m.clearFrontCorrections += e.line.clearFrontCorrectionSeconds; byModel.set(key, m);
}
writeFileSync(resolve(output, 'summary.json'), JSON.stringify({ name, episodes: report.episodes.length, groups: report.groups, byModel: [...byModel.values()], scope: report.scope }, null, 2));
console.log(JSON.stringify({ complete: true, count: files.length, report: resolve(output, 'report.json') }));
