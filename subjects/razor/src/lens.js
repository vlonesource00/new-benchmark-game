// Pure presentation of the controller's reported decisions. No inferred rival
// can replace a missing target: pit traffic must stay absent from pursuit UI.
export function razorLens(d, visual) {
  const cb = d.combat ?? {}, st = cb.stats ?? {};
  const gauge = (label, value, text) => ({ label, value: Math.max(0, Math.min(1, value ?? 0)), text });
  const kind = d.intent === 'ALONGSIDE' ? 'alongside' : d.intent === 'DEFEND' ? 'defend' : d.intent === 'ATTACK' ? 'attack' : d.intent === 'EVADE' || d.intent === 'WAIT' ? 'obstacle' : 'follow';
  return {
    intent: d.intent ?? 'INIT', sub: d.sub ?? '', side: d.side ?? 0, suppressInference: true,
    focus: d.focus != null ? { id: d.focus, kind } : null,
    cands: (cb.cands ?? []).map((c, i) => ({ label: `${c.kind}${c.side ? c.side > 0 ? ' · right' : ' · left' : ''}`,
      score: c.score, chosen: c.chosen, points: visual?.candidates?.[i]?.points,
      note: `${c.score?.toFixed(0)}${c.clear ? ' · clear ahead' : ''}` })),
    candNote: 'predicted progress · clearance and exit',
    gauges: [gauge('stability', d.stability, `${Math.round((d.stability ?? 1) * 100)}%`),
      gauge('grip used', d.latUse, `${Math.round((d.latUse ?? 0) * 100)}%`),
      gauge('wake', d.wake, `${Math.round((d.wake ?? 0) * 100)}%`),
      gauge('traction', d.tcCap, `${Math.round((d.tcCap ?? 1) * 100)}%`),
      gauge('nose brake', d.noseBrake, cb.contact ? 'front blocked' : 'open'),
      gauge('slip budget', (d.slipBudget ?? 2.1) / 2.4, d.slipBudget?.toFixed(2) ?? '')],
    counters: [{ label: 'attempts', value: st.attempts ?? 0 }, { label: 'passes after moves', value: st.associatedPasses ?? 0 },
      { label: 'aborted', value: st.aborts ?? 0 }, { label: 'evasions', value: st.evasions ?? 0 }, { label: 'plans', value: st.plans ?? 0 }],
    tags: [cb.tag, d.wake > 0.3 && 'in the wake', cb.contact && 'nose blocked'].filter(Boolean),
    log: (cb.events ?? []).slice(-6).reverse().map(e => `${e.t.toFixed(1)} s · ${e.kind} #${e.id}`)
  };
}
