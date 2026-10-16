// SLIPSTREAM debugger feed. The network has no plan to show, so this reports what it does compute, per decision:
// the router's share for the combat add-on (g), the pace driver's own action and the add-on's, the action sent, how
// stale the applied action is, and the rivals near the car. Two short projections show where each steering command
// points (the pace driver alone vs with the add-on), held for HORIZON s at the current speed with the yaw rate capped
// by grip: a picture of how much track width the add-on takes, not a prediction of the car's path. Passes are order
// changes in race progress with a car within 100 m that hold HOLD s, logged with the router share at the swap.

const HORIZON = 1.2, STEPS = 12, A_LAT = 15, HOLD = 2, NEAR = 70, KEEP = 8;
const wrapL = (d, L) => ((d % L) + L * 1.5) % L - L / 2;

export function createSlipstreamLens(track) {
  const L = track.length;
  const st = { g: null, base: null, cmb: null, out: [0, 0], age: 0, decisions: 0, combat: 0, passes: 0, addonPasses: 0, lost: 0 };
  const side = new Map(), events = [];
  let me = null, cars = [], time = 0;

  /** One decision: the actor's parts (MoE: base, cmb, gate), the action sent and the age of the action applied. */
  function decide(car, all, t, policy, sent, appliedAge) {
    me = car; cars = all; time = t;
    // A mixture-of-experts actor keeps each expert's last mean and the router output (browser/policy.mjs MoEPolicy).
    const moe = policy?.base?.buf && policy?.cmb?.buf;
    st.g = moe ? policy.gate : null; st.base = moe ? [policy.base.buf.mu[0], policy.base.buf.mu[1]] : null;
    st.cmb = moe ? [policy.cmb.buf.mu[0], policy.cmb.buf.mu[1]] : null; st.residual = moe ? policy.residual : false;
    st.out = sent; st.age = appliedAge; st.decisions++; if ((st.g ?? 0) > 0.5) st.combat++;
    for (const c of all) {
      if (c === car || c.race?.finishTime != null) continue;
      const d = wrapL((c.race?.progress ?? 0) - (car.race?.progress ?? 0), L) , ahead = d > 0, x = side.get(c.id);
      if (Math.abs(d) > 100) { side.delete(c.id); continue; }
      if (!x) { side.set(c.id, { ahead, since: t, pend: false, g: 0 }); continue; }
      if (ahead !== x.ahead) { x.ahead = ahead; x.since = t; x.pend = true; x.g = st.g ?? 0; }
      if (x.pend && t - x.since >= HOLD) {
        x.pend = false;
        const kind = ahead ? 'lost' : 'pass';
        if (kind === 'pass') { st.passes++; if (x.g > 0.5) st.addonPasses++; } else st.lost++;
        events.push({ t: x.since, kind, id: c.id, g: x.g }); if (events.length > KEEP) events.shift();
      }
    }
  }

  // Road coordinates (metres along the lap from the car, lateral offset) of a steering command held for HORIZON s.
  function project(steer) {
    if (!me) return [];
    const wb = me.spec?.wheelbase ?? 2.7, lock = me.spec?.steeringLock ?? 0.5, v = Math.max(me.speed, 1), dt = HORIZON / STEPS;
    const cap = A_LAT / v, rate = Math.max(-cap, Math.min(cap, v * Math.tan(steer * lock) / wb));
    let x = me.x, z = me.z, yaw = me.yaw;
    const pts = [], rp = [];
    for (let k = 0; k <= STEPS; k++) {
      const p = track.nearest(x, z);
      pts.push({ x, z }); rp.push([wrapL(p.s - me.s, L), p.lateral ?? 0]);
      x += v * Math.sin(yaw) * dt; z += v * Math.cos(yaw) * dt; yaw += rate * dt;
    }
    return { pts, rp };
  }

  function nearest() {
    if (!me) return [];
    return cars.filter((c) => c !== me).map((c) => ({ c, d: wrapL((c.race?.progress ?? 0) - (me.race?.progress ?? 0), L) }))
      .filter((r) => r.d < NEAR && r.d > -NEAR / 2).sort((a, b) => Math.abs(a.d) - Math.abs(b.d)).slice(0, 4);
  }

  // The car the add-on is working on, when it is in control: the closest car within a second ahead, alongside, or
  // close behind. Not declared by the network: it is the geometry at the moment the router hands over.
  function focus() {
    if ((st.g ?? 0) <= 0.5 || !me) return null;
    const v = Math.max(me.speed, 10), r = nearest()[0];
    if (!r) return null;
    const kind = Math.abs(r.d) < 5 ? 'alongside' : r.d > 0 && r.d / v < 1 ? 'attack' : r.d < 0 && -r.d / v < 0.6 ? 'defend' : null;
    return kind ? { id: r.c.id, kind } : null;
  }

  function debug() {
    // The add-on's share of the action: residual mode adds g * cmb to the pace driver's action, a mixture blends toward cmb.
    const f = focus(), corr = st.base && st.cmb && st.g != null ? [0, 1].map((k) => st.g * (st.residual ? st.cmb[k] : st.cmb[k] - st.base[k])) : null;
    return {
      architecture: 'SLIPSTREAM · learned direct control (PPO, GRU)' + (st.g != null ? ' + combat add-on' : ''),
      intent: st.g == null ? 'DRIVE' : f ? { attack: 'ATTACK', alongside: 'ALONGSIDE', defend: 'DEFEND' }[f.kind] : st.g > 0.5 ? 'COMBAT' : 'PACE',
      sub: st.g == null ? 'one network' : `router ${Math.round(st.g * 100)}% add-on`,
      focus: f?.id ?? null, focusKind: f?.kind ?? null,
      g: st.g, base: st.base, cmb: st.cmb, corr, out: st.out, age: st.age, wake: me?.aero?.wake ?? null,
      stats: { decisions: st.decisions, combatShare: st.decisions ? st.combat / st.decisions : 0, passes: st.passes, addonPasses: st.addonPasses, lost: st.lost },
      events: events.slice()
    };
  }

  function visualDebug() {
    if (!me) return null;
    const chosen = project(st.out[0]), alone = st.base ? project(st.base[0]) : null, f = focus();
    const v = me.speed, p = track.nearest(me.x, me.z);
    const rivals = nearest().map(({ c, d }) => { const q = track.nearest(c.x, c.z); return { id: c.id, d, l: q.lateral ?? 0, v: c.speed, kind: Math.abs(d) < 5 ? 'alongside' : d > 0 ? 'ahead' : 'behind', focus: f?.id === c.id }; });
    return {
      selectedTrajectory: { points: chosen.pts },
      candidates: [...(alone ? [{ kind: 'pace driver alone', points: alone.pts, score: 0, chosen: false }] : []), { kind: st.g != null ? 'with add-on' : 'sent', points: chosen.pts, score: 1, chosen: true }],
      extras: { half: track.halfWidth, me: { l: p.lateral ?? 0, v }, rivals, lanes: [...(alone ? [{ rp: alone.rp, chosen: false }] : []), { rp: chosen.rp, chosen: true }], contact: null, cap: null }
    };
  }

  function reset() { side.clear(); }
  return { decide, debug, visualDebug, reset };
}
