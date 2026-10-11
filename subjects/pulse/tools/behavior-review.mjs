import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME, digest } from './versions.mjs';
import { nearbyFront, lineReview } from '../src/body-geometry.mjs';
const args = process.argv.slice(2), i = args.indexOf('--name'), name = args[i + 1];
if (i < 0 || !/^[a-z0-9-]+$/i.test(name)) throw Error('New behavior review name required');
const output = resolve(HOME, 'artifacts/behavior-reviews', name);
if (existsSync(output)) throw Error('Preserve prior reviews');
mkdirSync(output, { recursive: true });
function load(episode, trace) {
  const replay = JSON.parse(readFileSync(resolve(HOME, 'results', episode + '.json'), 'utf8'));
  const bytes = readFileSync(resolve(HOME, 'artifacts', trace), 'utf8'), records = bytes.trim().split('\n').map(JSON.parse);
  return { ...replay, rows: records.filter(x => x.type === 'step'), source: trace, sourceDigest: digest(bytes) };
}
const reference = load('c35-outcome-best-physical-solo-policy', 'evaluations/c35-outcome-best-physical/solo-policy.jsonl');
const median = values => { const a = [...values].sort((a, b) => a - b); return a.length ? a[Math.floor(a.length / 2)] : null; };
function pedalReversals(rows, getter) {
  let previous = 0, changedAt = -99, count = 0;
  for (const row of rows) {
    const effort = getter(row); if (!Number.isFinite(effort)) continue;
    const sign = effort > .03 ? 1 : effort < -.03 ? -1 : 0;
    if (sign && sign !== previous) {
      if (previous && row.time - changedAt < .35) count++;
      changedAt = row.time; previous = sign;
    }
  }
  return count;
}
const buckets = Array.from({ length: 120 }, () => []), bin = s => Math.max(0, Math.min(119, Math.floor(s / reference.track.length * 120)));
for (const r of reference.rows.filter(r => r.before.lap >= 2)) buckets[bin(r.before.s)].push(r);
const curve = buckets.map(rs => ({ lateral: median(rs.map(r => r.before.lateral)), speed: median(rs.map(r => r.before.speed)) }));
const defaults = [
  ['c35-outcome-best-physical-traffic-policy', 'evaluations/c35-outcome-best-physical/traffic-policy.jsonl'],
  ['c36-outcome-first-transfer-c32-sequence-gap55-search', 'outcome-evaluations/c36-outcome-first-transfer/c32-sequence-gap55-search.jsonl'],
  ['c47-whole-history-transfer-c37-retained-clear-track', 'outcome-evaluations/c47-whole-history-transfer/c37-retained-clear-track.jsonl'],
  ['c51-gain-transfer-c37-retained-clear-track', 'outcome-evaluations/c51-gain-transfer/c37-retained-clear-track.jsonl'],
  ...['search-g0-n9', 'search-g2-n18', 'search-g0-n1'].map(id => ['c32-sequence-gap55-search-' + id, 'counterfactuals/c32-sequence-gap55-search/' + id + '.jsonl'])
];
const requested = args.flatMap((arg, i) => arg === '--case' ? [args[i + 1]] : []);
const sources = requested.length ? requested.map(value => {
  const at = value?.indexOf('=') ?? -1, episode = value?.slice(0, at), path = value?.slice(at + 1);
  if (at < 1 || !/^[a-z0-9-]+$/i.test(episode) || !path || path.startsWith('/') || path.includes('..')
    || !/^[a-z0-9_./-]+\.jsonl$/i.test(path)) throw Error('Case must be episode=relative-artifact-trace.jsonl');
  return [episode, path];
}) : defaults;
const report = { name, reference: reference.manifest.name, referenceDigest: reference.sourceDigest,
  scope: 'Full 60 Hz observation rows with 120 Hz execution summaries/contact evidence. Speed/line differences use distance-binned clean solo lap data, not a fastest-route oracle, matched lap-time loss or causality proof.', cases: [] };
for (const [episode, path] of sources) {
  const r = load(episode, path), fields = new Map(r.schema.fields.map((f, i) => [f.name, i]));
  const raw = (row, field) => row.observation.raw[fields.get(field)] ?? 0;
  const phases = [];
  for (let t = 0; t < r.summary.seconds - .001; t += 10) {
    const rows = r.rows.filter(row => row.time >= t - 1e-8 && row.time < t + 10 - 1e-8);
    const speeds = [], deviations = [], slips = [], corrections = [], safetyReasons = {};
    for (const row of rows) {
      const c = curve[bin(row.before.s)];
      if (c.speed !== null) speeds.push((c.speed - row.before.speed) * 3.6);
      if (c.lateral !== null) deviations.push(Math.abs(c.lateral - row.before.lateral));
      const psi = Math.atan2(raw(row, 'ego.headingSin'), raw(row, 'ego.headingCos'));
      const vf = raw(row, 'ego.forwardSpeed'), vs = raw(row, 'ego.sideSpeed');
      slips.push(Math.abs(Math.atan2(vs * Math.cos(psi) - vf * Math.sin(psi), vf * Math.cos(psi) + vs * Math.sin(psi))) * 180 / Math.PI);
      if (!nearbyFront(row)) corrections.push(Math.abs(row.trafficCorrection?.[0] ?? 0));
      for (const reason of row.safety) safetyReasons[reason] = (safetyReasons[reason] ?? 0) + 1;
    }
    const average = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const first = rows[0], last = rows.at(-1);
    phases.push({ start: t, meanSpeedKmH: average(rows.map(x => x.before.speed * 3.6)),
      meanSpeedBelowSoloKmH: average(speeds), meanDistanceFromSoloLineM: average(deviations), maxDistanceFromSoloLineM: Math.max(...deviations),
      meanBodySideslipDegrees: average(slips), clearFrontMeanSteeringCorrection: average(corrections),
      rapidPedalReversals: pedalReversals(rows, r => r.executed.throttle - r.executed.brake),
      policyRapidPedalReversals: pedalReversals(rows, r => r.policyProposal?.[1]),
      motorRapidPedalReversals: rows.some(r => r.localMotorAction) ? pedalReversals(rows, r => r.localMotorAction?.[1]) : null,
      safetyRows: rows.filter(r => r.safety.length).length, safetyReasons,
      fuelUsed: first.before.fuel - last.post.fuel, damageAdded: Math.max(0, last.post.damage - first.before.damage),
      hottestTyreCore: Math.max(...rows.flatMap(x => x.before.tyres.map(t => t.core))),
      worstWearSpent: Math.max(...last.post.tyres.map((tyre, i) => tyre.wear - first.before.tyres[i].wear)) });
  }
  const contacts = r.rows.flatMap(x => x.contactEvidence ?? []);
  report.cases.push({ episode, source: path, sourceDigest: r.sourceDigest, phases,
    line: lineReview(r.rows, r.track.halfWidth), firstContact: contacts[0] ?? null,
    maxOwnContactClosing: contacts.length ? Math.max(...contacts.map(c => c.closing)) : 0,
    summary: { legalSeconds: r.summary.seconds - r.summary.trackLimitSeconds, trackLimitSeconds: r.summary.trackLimitSeconds,
      cumulativeDamage: r.summary.cumulativeDamage, retainedPasses: r.summary.retainedPasses },
    replay: '/?episode=' + episode });
}
writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ complete: true, cases: report.cases.length, file: resolve(output, 'report.json') }));
