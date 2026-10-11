import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPolicy } from './policy.mjs';
import { HOME, versions } from './versions.mjs';
import { runScenario } from './scenario.mjs';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name', 'feedback'), trace = arg('trace', 'c04-limits/traffic-policy'), seconds = +arg('seconds', 3);
if (!/^[a-z0-9-]+$/i.test(name) || !/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(trace) || !(seconds > 0 && seconds <= 600)) throw Error('Invalid diagnostic arguments');
const out = resolve(HOME, 'artifacts/diagnostics', name + '.json');
if (existsSync(out)) throw Error('Diagnostic exists; use a new --name');
const packets = readFileSync(resolve(HOME, 'artifacts/evaluations', trace + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const rows = packets.filter(r => r.type === 'step' && r.time <= seconds);
const policy = await createPolicy(resolve(HOME, arg('model', 'artifacts/models/c04')));
const SCHEMA = policy.schema;
if (packets[0].versions.schemaDigest !== policy.metadata.schemaDigest) { await policy.dispose(); throw Error('Trace/checkpoint observation contract differs'); }
const field = name => SCHEMA.fields.findIndex(f => f.name === name);
const rms = values => Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
let hidden = Array(SCHEMA.hidden).fill(0), replayError = 0;
const output = [];
try {
  for (const row of rows) {
    // This probe reconstructs uninterrupted recurrence only. Reject traces
    // with dropped/delayed accepted states rather than inventing their memory.
    if (row.acceptedSequence !== row.index + 1) throw Error('Probe requires one accepted reply per observation');
    const x = row.observation.normalized, actual = await policy.step(x, hidden);
    replayError = Math.max(replayError, ...actual.action.map((v, i) => Math.abs(v - row.policyProposal[i])));
    const withoutRivals = [...x]; withoutRivals.fill(0, SCHEMA.groups.rivals.offset);
    const noRivals = await policy.step(withoutRivals, hidden);
    const sensitivities = {};
    // Partial derivatives are diagnostics, not physically coherent trajectories.
    for (const [key, delta] of [['ego.headingSin', .005], ['ego.roadOffset', .025], ['ego.sideSpeed', .025], ['ego.yawRate', .025]]) {
      const index = field(key), plus = [...x], minus = [...x];
      plus[index] += delta; minus[index] -= delta;
      const a = await policy.step(plus, hidden), b = await policy.step(minus, hidden);
      sensitivities[key] = (a.action[0] - b.action[0]) / (2 * delta);
    }
    output.push({ time: row.time, s: row.before.s, lateral: row.before.lateral,
      headingSin: x[field('ego.headingSin')], sideSpeed: x[field('ego.sideSpeed')],
      action: actual.action, expert: [row.teacherControls.steer, row.teacherControls.throttle - row.teacherControls.brake],
      withoutRivals: noRivals.action, sensitivities, safety: row.safety });
    hidden = actual.hidden;
  }
  if (replayError > 1e-5) throw Error(`Recorded recurrence mismatch ${replayError}`);
  const summary = { name, trace, model: policy.metadata.modelSha256, seconds, rows: output.length, replayError,
    steeringExpertRmse: rms(output.map(r => r.action[0] - r.expert[0])),
    rivalSteeringRmse: rms(output.map(r => r.action[0] - r.withoutRivals[0])),
    rivalSteeringMax: Math.max(...output.map(r => Math.abs(r.action[0] - r.withoutRivals[0]))),
      causalScope: 'Fixed-input sensitivity only; no rival/wake physics removed and no causal pass evidence', versions: versions(SCHEMA) };
  mkdirSync(resolve(HOME, 'artifacts/diagnostics'), { recursive: true });
  const physical = [];
  const physicalSeconds = +arg('physical-seconds', 0);
  if (physicalSeconds) {
    if (!(physicalSeconds > 0 && physicalSeconds <= 30)) throw Error('Physical sensitivity probe is bounded to 30 seconds');
    const settings = packets[0].settings;
    for (const maskRivals of [false, true]) {
      const settingsForRun = { ...settings, seconds: physicalSeconds, mode: 'policy', traceExpert: true };
      const result = await runScenario({ ...settingsForRun,
        policy: (x, h) => { const input = [...x]; if (maskRivals) input.fill(0, SCHEMA.groups.rivals.offset); return policy.step(input, h); },
        onRow: row => { if (maskRivals) { row.diagnosticPolicyObservation = [...row.observation.normalized]; row.diagnosticPolicyObservation.fill(0, SCHEMA.groups.rivals.offset); } } });
      const episode = name + (maskRivals ? '-masked-rivals' : '-visible-rivals');
      const manifest = { type: 'manifest', name: episode, split: 'test', settings: settingsForRun, versions: versions(SCHEMA),
        policy: policy.metadata, trainingOnly: false, teacherSuppliesStrategy: true,
        diagnostic: maskRivals ? 'Rival inputs hidden from network only; actual rivals, wakes, collisions and nose safety remain' : 'Unmodified network inputs',
        neverTraining: true, path: 'native' };
      writeFileSync(resolve(HOME, 'artifacts/diagnostics', episode + '.jsonl'), [manifest, ...result.rows, { type: 'summary', ...result.summary }].map(JSON.stringify).join('\n') + '\n');
      writeFileSync(resolve(HOME, 'results', episode + '.json'), JSON.stringify({ manifest, ...result, rows: result.rows.filter((_, i) => i % 3 === 0) }));
      physical.push({ maskRivals, ...result.summary, firstTrackViolation: result.events.find(e => e.type === 'track-limit-violation')?.time ?? null, replay: '/?episode=' + episode });
    }
  }
  writeFileSync(out, JSON.stringify({ summary, rows: output, physical }, null, 2));
  console.log(JSON.stringify({ ...summary, physical: physical.map(r => ({ maskRivals: r.maskRivals, firstTrackViolation: r.firstTrackViolation,
    maxRoadOffset: r.maxRoadOffset, damage: r.cumulativeDamage, progress: r.progress, expertRows: r.expertRows })), samples: output.filter((_, i) => i % 30 === 0) }));
} finally { await policy.dispose(); }
