// Provenance for review only. A modified "baseline" is still an offline trial.
export function replayKind(manifest, summary) {
  if (summary.mode === 'teacher') return 'expert';
  const trial = manifest.counterfactual;
  if (trial && (trial.label !== 'baseline' || trial.settle)) return 'offline-search';
  if (summary.expertActuatorRows || summary.expertRows || manifest.diagnostic || summary.mode !== 'policy')
    return 'assisted/diagnostic';
  return 'fitted-NN';
}
