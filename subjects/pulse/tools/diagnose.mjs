import { readFileSync } from 'node:fs';
const path = process.argv[2]; if (!path) throw Error('Usage: node tools/diagnose.mjs results/episode.json');
const replay = JSON.parse(readFileSync(path, 'utf8')), rows = replay.rows;
const histogram = field => Object.fromEntries([...new Set(rows.flatMap(r => r.observation[field]))].map(key => [key, rows.filter(r => r.observation[field].includes(key)).length]));
const summary = { scenario: replay.manifest.settings, episode: replay.manifest.episodeId, scope: replay.summary.scope,
  progress: replay.summary.progress, retainedPasses: replay.summary.retainedPasses, hazardsCleared: replay.summary.hazardsCleared,
  cumulativeDamage: replay.summary.cumulativeDamage, offTrackSeconds: replay.summary.offTrackSeconds,
  sensorClips: histogram('clipped'), missingSensors: histogram('missing'), mailbox: replay.summary.mailbox,
  firstDeparture: replay.events.find(e => e.type === 'off-track'), firstDamage: replay.events.find(e => e.type === 'damage'),
  passing: replay.events.filter(e => ['retained-pass', 'hazard-cleared'].includes(e.type)),
  latency: replay.summary.latencyMs };
const neural = rows.filter(r => r.policyProposal && r.teacherControls);
if (neural.length) {
  const steerError = neural.map(r => Math.abs(r.policyProposal[0] - r.teacherControls.steer));
  summary.teacherSteerDeviation = { mean: steerError.reduce((a, b) => a + b, 0) / steerError.length, max: Math.max(...steerError) };
  summary.initialControls = neural.slice(0, 5).map(r => ({ time: r.time, policy: r.policyProposal, teacher: r.teacherControls, executed: r.executed }));
}
console.log(JSON.stringify(summary, null, 2));
