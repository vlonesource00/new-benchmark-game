// Expert-history counterfactuals are measurements, never alternate driving labels.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPolicy } from './policy.mjs';
import { runScenario } from './scenario.mjs';
import { HOME, versions, digest } from './versions.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name'), seconds = +arg('seconds', 40), model = arg('model');
if (!name || !/^[a-z0-9-]+$/i.test(name) || !model || !(seconds >= 1 && seconds <= 120)) throw Error('Use a new name, model and bounded duration');
const output = resolve(HOME, 'artifacts/diagnostics', name);
if (existsSync(output)) throw Error('Diagnostic exists; use a new name');
mkdirSync(output, { recursive: true });
const policy = await createPolicy(resolve(HOME, model));
const report = { name, model, versions: versions(policy.schema), cases: [] };
try {
  for (const mode of ['teacher', 'policy']) {
    const settings = { seconds, mode, fixture: 'solo', seed: 27, observationVersion: policy.metadata.schemaVersion,
      traceExpert: true, probeExpertHistory: true };
    const result = await runScenario({ ...settings, policy: mode === 'policy' ? policy.step : undefined });
    const manifest = { type: 'manifest', format: 'pulse-episode-v1', episodeId: digest(settings), settings,
      name: name + '-' + mode, split: 'test', neverTraining: true, versions: report.versions,
      policy: mode === 'policy' ? policy.metadata : null, path: 'native', teacherSuppliesStrategy: true };
    writeFileSync(resolve(output, mode + '.jsonl'), [manifest, ...result.rows, { type: 'summary', ...result.summary }].map(r => JSON.stringify(r)).join('\n') + '\n');
    const firstFailure = result.events.find(e => e.type === 'track-limit-violation' || e.type === 'damage')?.time ?? seconds;
    const groups = [
      ['clean-prefix', r => r.time <= firstFailure],
      ['last-three-seconds', r => r.time <= firstFailure && r.time >= firstFailure - 3]
    ].map(([group, keep]) => {
      const rows = result.rows.filter(keep), rms = key => Math.sqrt(rows.reduce((s, r) => s + key(r) ** 2, 0) / Math.max(1, rows.length));
      return { group, rows: rows.length,
        steeringMemoryDifferenceRmse: rms(r => r.teacherControls.steer - r.teacherHistoryProbe.withoutCurvatureMemory.steer),
        steeringErrorContinuousRmse: mode === 'policy' ? rms(r => r.policyProposal[0] - r.teacherControls.steer) : null,
        steeringErrorInstantaneousRmse: mode === 'policy' ? rms(r => r.policyProposal[0] - r.teacherHistoryProbe.withoutCurvatureMemory.steer) : null,
        curvatureLimitedFraction: rows.filter(r => Math.abs(r.teacherHistoryProbe.continuousCurvature - r.teacherHistoryProbe.instantaneousCurvature) > 1e-5).length / Math.max(1, rows.length),
        worst: [...rows].sort((a, b) => Math.abs(b.teacherControls.steer - b.teacherHistoryProbe.withoutCurvatureMemory.steer) - Math.abs(a.teacherControls.steer - a.teacherHistoryProbe.withoutCurvatureMemory.steer)).slice(0, 3)
          .map(r => ({ time: r.time, s: r.before.s, speed: r.before.speed, lateral: r.before.lateral,
            continuous: r.teacherControls.steer, instantaneous: r.teacherHistoryProbe.withoutCurvatureMemory.steer,
            policy: r.policyProposal?.[0] ?? null })) };
    });
    report.cases.push({ mode, firstFailure, groups, summary: result.summary });
    console.log(JSON.stringify({ mode, firstFailure, groups }));
  }
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
} finally { await policy.dispose(); }
