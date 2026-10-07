// Architecture lens: each AI reports what it is thinking in its own terms
// (debug() and visualDebug(), relayed from its seat worker). A profile per
// architecture translates that into one visual model the debugger draws on
// the car and in the panel: what it intends, which rival it is working on,
// the side it is going for, the path it plans, the options it weighed, and
// the internal quantities that drive its decisions. Fields an AI does not
// report stay empty; nothing is invented. A focus the AI did not declare is
// inferred from the field and marked as such.

const TONES = {
  attack: '#ff4d6d', alongside: '#ff8f3d', defend: '#4f8cff', follow: '#ffb02e',
  yield: '#9aa4b2', pit: '#c77dff', recover: '#ff3b3b', pace: '#3ddc84'
};
export const toneColor = (tone) => TONES[tone] ?? TONES.pace;

export function toneOf(label) {
  const s = String(label ?? '').toLowerCase();
  if (/recover|spin|stall|emerg|rescue/.test(s)) return 'recover';
  if (/pit/.test(s)) return 'pit';
  if (/yield|lapped|let.?by/.test(s)) return 'yield';
  if (/alongside|side.?by/.test(s)) return 'alongside';
  if (/attack|pass|overtak|commit|move|lunge|dive/.test(s)) return 'attack';
  if (/defen|cover|guard|block|protect/.test(s)) return 'defend';
  if (/follow|tow|draft|hold|trail|queue|stalk/.test(s)) return 'follow';
  return 'pace';
}

const num = (x) => (Number.isFinite(x) ? x : null);
const clamp01 = (x) => Math.max(0, Math.min(1, x || 0));
const pct = (x) => `${Math.round(x * 100)}%`;
const gauge = (label, value, text, color) => (value == null ? null : { label, value: clamp01(value), text, color });
const counter = (label, value) => (value == null || value === '' ? null : { label, value });
const idOf = (race, id) => (id == null ? null : race.cars.findIndex((c) => c.id === id || String(c.id) === String(id)));

// Per-architecture identity: colour for the plan and a one-line reading of how it thinks.
const THEMES = {
  'claude-revolution': { color: '#d97757', mind: 'Scores lanes against predicted rivals; commits one move per corner' },
  'next-racer': { color: '#ff2e63', mind: 'Simulates manoeuvre outcomes; commits to the best exit' },
  solstice: { color: '#ffb000', mind: 'Whole-lap line with live axle forces; traffic rollouts' },
  astra: { color: '#df482d', mind: 'Tactical planner over chassis rollouts and a friction envelope' },
  'gemini-supreme-v4': { color: '#4285f4', mind: 'Offline min-time line tracked by a tyre-aware MPCC' },
  phantom: { color: '#9b5de5', mind: 'Imitates a ghost tape; MPPI rollouts on an exact plant' },
  'phantom-v2': { color: '#b388ff', mind: 'Ghost tape v2 with an adaptive plant model' },
  'solinator-6.1': { color: '#ffce45', mind: 'Gate-to-gate arrivals; full-plant transfer graph' },
  apex: { color: '#00e0b8', mind: 'Identified g-g-v limit line; shadow lanes rolled out against predicted rivals' }
};

// CRV packs its scored lanes as "kind*:score ..." in debug() and as geometry in visualDebug().
function crvCands(dbg, vis) {
  if (Array.isArray(vis?.candidates) && vis.candidates.length) return vis.candidates.map((c) => ({ label: c.kind, score: c.score, chosen: c.chosen, points: c.points }));
  return String(dbg.cands ?? '').split(' ').filter(Boolean).map((t) => { const [k, v] = t.split(':'); return { label: k.replace('*', ''), score: Number(v), chosen: k.endsWith('*') }; });
}

const PROFILES = {
  'claude-revolution'(d, v) {
    const state = d.combat ?? 'RACE';
    const guarding = /DEFEND|COVER/.test(state) && d.threat != null;
    const focus = !guarding && d.focus != null ? { id: d.focus, kind: state === 'ATTACK' || d.lane === 'tow' ? 'attack' : 'follow' } : d.threat != null ? { id: d.threat, kind: 'defend' } : null;
    return {
      intent: state, sub: `${d.intent ?? ''} · lane ${d.lane ?? 'line'}${d.draft ? ' · in tow' : ''}`, focus, block: d.blocker,
      cands: crvCands(d, v), candNote: 'lane scores (time gained, risk, position)',
      gauges: [
        gauge('stability (ESC)', num(d.stability), num(d.stability) == null ? '' : pct(d.stability), d.stability < .5 ? '#ff4d4d' : '#3ddc84'),
        gauge('speed vs line', num(d.targetSpeed) && num(d.lineSpeed) ? d.targetSpeed / Math.max(1, d.lineSpeed) : null, num(d.lineSpeed) ? `${Math.round(d.targetSpeed * 3.6)} / ${Math.round(d.lineSpeed * 3.6)} km/h` : ''),
        gauge('traffic cap', num(d.cap) && num(d.lineSpeed) ? Math.min(1, d.cap / Math.max(1, d.lineSpeed)) : null, num(d.cap) ? `${Math.round(d.cap * 3.6)} km/h` : 'free', '#ffb02e')
      ],
      counters: [counter('moves', d.moves), counter('aborts', d.aborts), counter('passes', d.passes), counter('lap est', num(d.lapEstimate)?.toFixed(2))],
      tags: [d.moveSide && `move ${d.moveSide}`, d.reflexCap != null && 'reflex brake', Math.abs(d.nudge ?? 0) > .05 && 'side nudge'].filter(Boolean)
    };
  },
  'next-racer'(d) {
    const role = d.plan?.role ?? d.plan?.kind ?? '';
    const focus = d.target != null ? { id: d.target, kind: /defen|cover/.test(role) ? 'defend' : /follow|tow/.test(role) ? 'follow' : 'attack' } : null;
    const rows = Array.isArray(d.evaluated) ? d.evaluated : Array.isArray(d.checks) ? d.checks : [];
    const chosen = d.plan?.kind;
    return {
      intent: d.intent ?? 'INIT', sub: `${d.stage ?? ''}${d.plan?.kind ? ` · ${d.plan.kind}` : ''}${d.safety ? ` · safety ${d.safety}` : ''}`, focus,
      side: d.side || d.plan?.side || 0,
      cands: rows.slice(0, 10).map((r) => ({ label: `${r.kind ?? '?'}${r.side ? (r.side > 0 ? ' +' : ' −') : ''}`, score: r.score, chosen: r.kind === chosen, note: num(r.exitSpeed) ? `exit ${Math.round(r.exitSpeed * 3.6)}` : '' })),
      candNote: 'manoeuvre outcomes (score · exit speed)',
      gauges: [
        gauge('sideslip β', num(d.control?.beta) == null ? null : Math.abs(d.control.beta) / .2, num(d.control?.beta) == null ? '' : `${(d.control.beta * 57.3).toFixed(1)}°`, Math.abs(d.control?.beta ?? 0) > .12 ? '#ff4d4d' : '#4fd1e8'),
        gauge('accel demand', num(d.control?.demand) == null ? null : Math.abs(d.control.demand) / 20, num(d.control?.demand) == null ? '' : `${d.control.demand.toFixed(1)} m/s²`),
        gauge('resource pace', num(d.resources?.factor), num(d.resources?.factor) == null ? '' : `${pct(d.resources.factor)}${d.resources.push ? ' PUSH' : d.resources.saveFuel ? ' save fuel' : ''}`, '#c77dff')
      ],
      counters: [counter('passes', d.stats?.passes), counter('emergencies', d.stats?.emergencies), counter('plans', d.stats?.plans), counter('rollouts', d.stats?.rollouts)],
      tags: [d.resources?.push && 'push', d.resources?.saveFuel && 'fuel save'].filter(Boolean)
    };
  },
  solstice(d) {
    const p = d.plan ?? {}, t = d.traffic ?? {};
    return {
      intent: d.intent ?? 'INIT', sub: p.push ? 'push' : p.coast ? 'coasting' : p.yield ? 'yielding' : '',
      gauges: [
        gauge('pace factor', num(p.factor), num(p.factor) == null ? '' : pct(p.factor)),
        gauge('lookahead', num(p.lookahead) == null ? null : p.lookahead / 1.5, num(p.lookahead) == null ? '' : `${p.lookahead.toFixed(2)} s`, '#4fd1e8'),
        gauge('plan cost', num(d.stats?.cost) == null ? null : Math.abs(d.stats.cost) / 40, num(d.stats?.cost) == null ? '' : d.stats.cost.toFixed(1), '#ffb02e')
      ],
      counters: [counter('attacks', t.attackStarts), counter('alongside', t.alongsideEpisodes), counter('passes', t.completedPasses), counter('aborted', t.abortedAttacks), counter('defends', t.defendMoves), counter('capped', t.capEpisodes)],
      tags: [p.trafficLine && 'traffic line', p.yield && 'yield', p.push && 'push', p.coast && 'coast', p.hold != null && 'hold', p.forceGuard && 'guard'].filter(Boolean)
    };
  },
  astra(d) {
    const focus = d.targetId != null ? { id: d.targetId, kind: toneOf(d.manoeuvre ?? d.state) === 'defend' ? 'defend' : 'attack' } : null;
    return {
      intent: d.state ?? d.intent ?? 'INIT', sub: `${d.manoeuvre ?? ''}${d.strategy ? ` · ${d.strategy}` : ''}`, focus, side: d.side || 0,
      gauges: [
        gauge('friction μ', num(d.friction) == null ? null : d.friction / 2, num(d.friction) == null ? '' : `${d.friction.toFixed(2)}${num(d.gripPeak) ? ` · peak ${d.gripPeak.toFixed(2)}` : ''}`),
        gauge('aggression', num(d.aggression), num(d.aggression) == null ? '' : pct(d.aggression), '#ff4d6d'),
        gauge('response risk', num(d.responseRisk), num(d.responseRisk) == null ? '' : pct(d.responseRisk), '#ffb02e'),
        gauge('rear exposure', num(d.rearExposure), num(d.rearExposure) == null ? '' : pct(d.rearExposure), '#4f8cff'),
        gauge('commit', num(d.commit), num(d.commit) == null ? '' : pct(d.commit), '#ff8f3d')
      ],
      counters: [counter('rollouts', d.candidates), counter('rejected', d.rejected), counter('exit gain', num(d.exitAdvantage)?.toFixed(2)), counter('plan ms', num(d.ms)?.toFixed(1))],
      tags: [d.flowTarget != null && 'flow target'].filter(Boolean)
    };
  },
  'gemini-supreme-v4'(d) {
    const s = d.stats ?? {};
    return {
      intent: d.intent ?? 'line', sub: s.rec ? 'recovering' : '',
      gauges: [
        gauge('grip used', num(s.util), num(s.util) == null ? '' : pct(s.util)),
        gauge('grip estimate', num(s.grip) == null ? null : s.grip / 1.2, num(s.grip) == null ? '' : s.grip.toFixed(3), '#4fd1e8'),
        gauge('governor', num(s.gov), num(s.gov) == null ? '' : pct(s.gov), '#ffb02e'),
        gauge('line error', num(s.e) == null ? null : Math.abs(s.e) / 2, num(s.e) == null ? '' : `${s.e.toFixed(2)} m`, '#ff4d6d'),
        gauge('sideslip β', num(s.beta) == null ? null : Math.abs(s.beta) / .2, num(s.beta) == null ? '' : `${(s.beta * 57.3).toFixed(1)}°`, '#ff8f3d')
      ],
      counters: [counter('target', num(s.vt) == null ? null : `${Math.round(s.vt * 3.6)} km/h`), counter('vCap', num(s.vCap) == null ? null : `${Math.round(s.vCap * 3.6)} km/h`), counter('offset', num(s.off)?.toFixed(2))],
      tags: [s.rec && 'recovery'].filter(Boolean)
    };
  },
  phantom(d) {
    const s = d.stats ?? {};
    return {
      intent: d.intent ?? 'INIT', sub: 'ghost imitation',
      gauges: [gauge('plan value', num(s.best) == null ? null : clamp01(1 + s.best / 5), num(s.best) == null ? '' : s.best.toFixed(2), '#9b5de5')],
      counters: [counter('plans', s.plans), counter('off-track', s.offtrack), counter('contacts', s.contact)]
    };
  },
  'solinator-6.1'(d) {
    const rows = Array.isArray(d.candidates) ? d.candidates : [];
    const best = rows.reduce((m, r) => Math.max(m, r.score ?? -Infinity), -Infinity);
    return {
      intent: d.state ?? 'INIT', sub: d.planSource ? 'gate transfers' : '',
      cands: rows.slice(0, 10).map((r, k) => ({ label: `#${k + 1}${r.hard ? ' hard' : ''}`, score: r.score, chosen: r.score === best, note: `${num(r.progress)?.toFixed(0) ?? '?'} m · tyre ${num(r.tyreCost)?.toFixed(2) ?? '?'} · gap ${num(r.clearance)?.toFixed(1) ?? '?'}` })),
      candNote: 'gate transfers (progress · tyre cost · clearance)',
      gauges: [gauge('plan acceptance', d.stats ? d.stats.acceptedPlans / Math.max(1, d.stats.acceptedPlans + d.stats.rejected) : null, d.stats ? `${d.stats.acceptedPlans} / ${d.stats.acceptedPlans + d.stats.rejected}` : '', '#ffce45')],
      counters: [counter('accepted', d.stats?.acceptedPlans), counter('rejected', d.stats?.rejected)]
    };
  }
};
// APEX: lanes weighed against predicted rivals; the radar (road coordinates) and extras come from visualDebug().
PROFILES.apex = (d, v) => {
  const cb = d.combat ?? {}, st = cb.stats ?? {}, x = v?.extras ?? null;
  const raw = Array.isArray(v?.candidates) && v.candidates.length ? v.candidates : cb.cands ?? [], top = raw.reduce((m, c) => Math.max(m, c.score ?? -Infinity), -Infinity);
  // a lane that is simply blocked scores far below the rest; the bars clip it so the real choices stay readable
  const rk = (id) => (cb.cands ?? []).find((c) => c.kind === id)?.risk;
  const cands = raw.map((c) => ({ label: c.kind, score: Math.max(c.score, top - 60), chosen: c.chosen, points: c.points, note: `${c.score.toFixed(0)}${num(c.risk ?? rk(c.kind)) && (c.risk ?? rk(c.kind)) > 0.5 ? ` · risk ${(c.risk ?? rk(c.kind)).toFixed(0)} m` : ''}` }));
  const ev = (cb.events ?? []).slice().reverse().map((e) => `${e.t.toFixed(0)} s  ${e.kind === 'pass' ? '▲ PASS' : '▼ PASSED'} #${e.rival}  ${e.kind === 'pass' ? (e.moved ? 'by move' : 'on pace') : e.tag}  ${e.edge >= 0 ? '+' : ''}${e.edge} m/s`);
  return {
    intent: d.intent ?? 'INIT', sub: d.sub ?? '', focus: d.focus != null ? { id: d.focus, kind: d.focusKind ?? 'follow' } : null, side: d.side ?? 0,
    cands, candNote: 'lanes weighed (position gained − contact price)',
    gauges: [
      gauge('stability', num(d.stability), num(d.stability) == null ? '' : pct(d.stability), d.stability < .5 ? '#ff4d4d' : '#3ddc84'),
      gauge('grip used', num(d.latUse), num(d.latUse) == null ? '' : pct(clamp01(d.latUse)), '#4fd1e8'),
      gauge('speed vs line', num(d.targetSpeed) && num(d.lineSpeed) ? d.targetSpeed / Math.max(1, d.lineSpeed) : null, num(d.lineSpeed) ? `${Math.round(d.targetSpeed * 3.6)} / ${Math.round(d.lineSpeed * 3.6)} km/h` : ''),
      gauge('traffic cap', num(cb.cap) && num(d.lineSpeed) ? Math.min(1, cb.cap / Math.max(1, d.lineSpeed)) : null, num(cb.cap) ? `${Math.round(cb.cap * 3.6)} km/h` : 'free', '#ffb02e'),
      gauge('dirty air', num(d.wake), num(d.wake) == null ? '' : pct(clamp01(d.wake)), '#9aa4b2'),
      gauge('traction', num(d.tcCap), num(d.tcCap) == null ? '' : pct(d.tcCap), '#c77dff'),
      gauge('contact risk', num(cb.contact?.closing) ? cb.contact.closing / 4 : 0, cb.contact ? `${cb.contact.closing} m/s in ${cb.contact.t.toFixed(1)} s` : 'none', cb.contact?.closing > 2.4 ? '#ff4d4d' : '#ff8f3d')
    ],
    counters: [counter('passes', st.passes), counter('by move', st.movePasses), counter('on pace', st.pacePasses), counter('passed by', st.lost), counter('guards', st.guards), counter('plans', st.plans), counter('lane changes', st.lanes)],
    tags: [cb.tag && cb.tag !== 'follow' && cb.tag, num(cb.cap) && 'speed cap', cb.contact && 'contact forecast', d.wake > .3 && 'in the wake'].filter(Boolean),
    log: ev,
    radar: x ? { half: x.half, me: x.me, rivals: x.rivals ?? [], lanes: x.lanes ?? [], contact: x.contact ?? null, cap: x.cap ?? null } : null,
    extras: x
  };
};
PROFILES['phantom-v2'] = PROFILES.phantom;

/** Infer who a car is racing when its AI does not say: the nearest car ahead, else one closing from behind. */
function inferFocus(race, idx) {
  const me = race.cars[idx], L = race.track.length;
  let best = null;
  race.cars.forEach((c, k) => {
    if (k === idx || c.race?.finishTime != null) return;
    let ds = (c.race?.progress ?? 0) - (me.race?.progress ?? 0);
    if (!Number.isFinite(ds)) return;
    ds = ((ds % L) + L * 1.5) % L - L / 2;
    const kind = ds > 3 && ds < 60 ? 'follow' : ds <= 3 && ds >= -6 ? 'alongside' : ds < -6 && ds > -25 && c.speed > me.speed - 1 ? 'defend' : null;
    if (kind && (!best || Math.abs(ds) < Math.abs(best.ds))) best = { id: c.id, kind, ds };
  });
  return best;
}

export function lensModel(race, idx, archId, dbg = {}, vis = null) {
  const prof = PROFILES[archId], theme = THEMES[archId] ?? { color: '#ffffff', mind: dbg.planSource ?? '' };
  const m = { intent: dbg.intent ?? dbg.state ?? null, sub: '', cands: [], gauges: [], counters: [], tags: [], ...(prof ? prof(dbg, vis) : {}) };
  m.theme = theme; m.arch = archId;
  m.gauges = (m.gauges ?? []).filter(Boolean); m.counters = (m.counters ?? []).filter(Boolean);
  m.tone = toneOf(m.intent);
  if (m.focus) { m.focus.declared = true; m.focus.index = idOf(race, m.focus.id); if (m.focus.index < 0) m.focus = null; }
  if (!m.focus) { const f = inferFocus(race, idx); if (f) m.focus = { ...f, declared: false, index: idOf(race, f.id) }; }
  if (m.block != null) { const b = idOf(race, m.block); m.block = b >= 0 ? b : null; }
  const pts = vis?.selectedTrajectory?.points;
  m.path = Array.isArray(pts) && pts.length > 1 ? pts : null;
  m.pathColor = vis?.selectedTrajectory?.color ?? theme.color;
  const aim = vis?.trackingPoint ?? dbg.trackingPoint ?? null;
  m.aim = aim && Number.isFinite(aim.x) ? aim : null;
  m.side = Math.sign(m.side || 0);
  return m;
}
