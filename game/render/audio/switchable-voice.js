// Keep the mix graph and AudioParam contract stable while changing the engine renderer.
// At most a short fade overlaps the two backends; retired worklets are explicitly stopped.
export function switchableVoice(ctx, create, initialV2, mode, seed, profile, defaults) {
  const output = ctx.createGain(), intake = ctx.createGain(), active = new Set();
  const schedules = Object.fromEntries(Object.keys(defaults).map((k) => [k, []]));
  const remember = (k, method, args) => {
    const q = schedules[k], past = q.filter((e) => e.args[1] < ctx.currentTime).slice(-1);
    schedules[k] = [...past, ...q.filter((e) => e.args[1] >= ctx.currentTime), { method, args }];
  };
  let current, v2 = initialV2;
  const params = Object.fromEntries(Object.entries(defaults).map(([k, value]) => [k, {
    get value() { return current?.raw.params[k].value ?? value; },
    set value(v) { value = v; schedules[k] = []; for (const x of active) x.raw.params[k].value = v; },
    setTargetAtTime(v, t, tau) { value = v; remember(k, 'setTargetAtTime', [v, t, tau]); for (const x of active) x.raw.params[k].setTargetAtTime(v, t, tau); return this; },
    setValueAtTime(v, t) { value = v; remember(k, 'setValueAtTime', [v, t]); for (const x of active) x.raw.params[k].setValueAtTime(v, t); return this; },
    cancelScheduledValues(t) { schedules[k] = schedules[k].filter((e) => e.args[1] < t); for (const x of active) x.raw.params[k].cancelScheduledValues(t); return this; }
  }]));
  const stop = (x) => { if (!active.delete(x)) return; x.raw.dispose(); x.exhaust.disconnect(); x.intake.disconnect(); };
  function select(next, immediate = false) {
    if (current && next === v2) return;
    const previous = current, raw = create(mode, seed, profile, next), t = ctx.currentTime;
    const x = { raw, exhaust: ctx.createGain(), intake: ctx.createGain() };
    for (const k in defaults) {
      raw.params[k].value = previous ? previous.raw.params[k].value : defaults[k];
      const q = schedules[k], last = q.filter((e) => e.args[1] < t).slice(-1)[0];
      if (last?.method === 'setTargetAtTime') raw.params[k].setTargetAtTime(last.args[0], t, last.args[2]);
      for (const e of q) if (e.args[1] >= t) raw.params[k][e.method](...e.args);
    }
    raw.out(x.exhaust); raw.outIntake?.(x.intake); x.exhaust.connect(output); x.intake.connect(intake);
    active.add(x); current = x; v2 = next;
    for (const g of [x.exhaust.gain, x.intake.gain]) { g.value = previous && !immediate ? 0 : 1; if (previous && !immediate) g.linearRampToValueAtTime(1, t + 0.18); }
    if (previous) {
      for (const g of [previous.exhaust.gain, previous.intake.gain]) { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + 0.18); }
      setTimeout(() => stop(previous), 240);
    }
  }
  select(initialV2, true);
  return { mode, params, out: (dest) => output.connect(dest), outIntake: mode === 'focus' ? (dest) => intake.connect(dest) : null,
    setProfile(p, live = false) { profile = p; for (const x of active) x.raw.setProfile(p, live); },
    setV2: select,
    dispose() { for (const x of active) stop(x); output.disconnect(); intake.disconnect(); }
  };
}
