// Live AI debugger (B): a visual read of what the focused car's controller is
// doing, in the spirit of the sandbox's Architecture Lens. AI seats run on
// workers, so the panel draws what the main thread can see: the controls the
// AI just sent, its debug() summary (relayed while the panel is open, see
// AsyncSeats.wantDebug), the car's own state and the class racing line.
import { esc } from './format.js';
import { lensModel, toneColor } from './lens-model.js';
import { AiScope } from './ai-scope.js';
import { AI_DRIVERS } from '../core/teams.js';
import { TANK_LITRES, WEAR_CLIFF } from '../core/rules.js';

const W = 300, H = 452, TRACE = 12; // seconds of speed trace
// One docked panel, one view at a time (B opens it, V or a click picks the tab): the car's telemetry, the AI's
// mind (intent, options, controller), its radar and its event log. Tabs an AI has nothing for are hidden.
const TABS = [['car', 'CAR'], ['mind', 'MIND'], ['scope', '3D'], ['radar', 'RADAR'], ['strat', 'STRATEGY'], ['log', 'LOG']];
const TAB_KEY = 'aidebug.tab';
const kmh = (v) => Math.round(v * 3.6);
const clamp01 = (x) => Math.max(0, Math.min(1, x || 0));

// Tyre core temperature: blue cold, green in the window, orange hot, red cooked.
export function tempColor(t) {
  return t < 70 ? '#4a8cff' : t < 82 ? '#4fd1e8' : t < 108 ? '#3ddc84' : t < 122 ? '#ffb02e' : '#ff4d4d';
}

export class AiDebugPanel {
  constructor(parent) {
    this.el = document.createElement('div');
    this.el.className = 'aidebug';
    this.el.hidden = true;
    this.el.innerHTML = '<div class="dh"></div><div class="dtabs"></div>'
      + '<div class="dpane" data-tab="car"><canvas></canvas><div class="dchips"></div></div>'
      + '<div class="dpane aimind" data-tab="mind"><div class="mh"></div><canvas></canvas><div class="mb"></div></div>'
      + '<div class="dpane" data-tab="scope"></div>'
      + '<div class="dpane aimind" data-tab="radar"><div class="mh"></div><canvas class="radar"></canvas></div>'
      + '<div class="dpane aimind" data-tab="strat"><div class="mh"></div><div class="mb"></div></div>'
      + '<div class="dpane aimind" data-tab="log"><div class="mh"></div><div class="mb"></div></div>'
      + '<div class="dfoot">B close · V next tab · Tab next car</div>';
    const q = (sel) => this.el.querySelector(sel);
    this.head = q('.dh'); this.tabBar = q('.dtabs');
    this.panes = Object.fromEntries([...this.el.querySelectorAll('.dpane')].map((x) => [x.dataset.tab, x]));
    this.canvas = q('[data-tab=car] canvas'); this.chips = q('.dchips');
    this.canvas.width = W * 2; this.canvas.height = H * 2;
    this.ctx = this.canvas.getContext('2d'); this.ctx.scale(2, 2);
    this.trace = []; this.gg = []; this.focus = null;
    // What this AI says it is thinking, in its own terms (mind, radar and log tabs).
    this.mind = this.panes.mind;
    this.mindHead = q('[data-tab=mind] .mh'); this.timeline = q('[data-tab=mind] canvas'); this.mindBody = q('[data-tab=mind] .mb');
    this.radarHead = q('[data-tab=radar] .mh'); this.radarCv = q('[data-tab=radar] canvas');
    this.logHead = q('[data-tab=log] .mh'); this.logBody = q('[data-tab=log] .mb');
    this.stratHead = q('[data-tab=strat] .mh'); this.stratBody = q('[data-tab=strat] .mb');
    this.calls = []; this.stratAt = 0;
    this.radarCv.width = 560; this.radarCv.height = 420;
    this.scope = new AiScope(this.panes.scope);
    this.timeline.width = 560; this.timeline.height = 64;
    this.intents = []; this.model = null; this.tagName = ''; this.mindAt = 0;
    this.tab = 'car'; try { this.tab = localStorage.getItem(TAB_KEY) || 'car'; } catch { /* no storage */ }
    this.avail = ['car'];
    this.tabBar.addEventListener('pointerdown', (ev) => { const b = ev.target.closest('[data-tab]'); if (b) { ev.preventDefault(); this.setTab(b.dataset.tab); } });
    parent.append(this.el);
    this.showTabs();
  }
  get open() { return !this.el.hidden; }
  toggle(on = !this.open) { this.el.hidden = !on; this.scope.show(on && this.shown === 'scope'); return on; }
  /** Next tab (V), or a named one; remembered for the next race. */
  setTab(id = null) {
    const a = this.avail;
    this.tab = id ?? a[(a.indexOf(this.shown) + 1) % a.length];
    try { localStorage.setItem(TAB_KEY, this.tab); } catch { /* no storage */ }
    this.showTabs();
  }
  showTabs() {
    const shown = this.avail.includes(this.tab) ? this.tab : 'car';
    this.tabBar.innerHTML = TABS.filter(([id]) => this.avail.includes(id)).map(([id, name]) => `<button data-tab="${id}" class="${id === shown ? 'on' : ''}">${name}</button>`).join('');
    for (const [id, pane] of Object.entries(this.panes)) pane.hidden = id !== shown;
    this.shown = shown;
    // The 3D view gets a wider panel, and renders only while it is the tab on screen.
    this.el.classList.toggle('wide', shown === 'scope');
    this.scope?.show(this.open && shown === 'scope');
  }

  update(race, focusId, teamsById) {
    if (!this.open || !race) return;
    const e = race.entries[focusId], car = race.cars[focusId];
    if (!e || !car) return;
    const team = e.team, bridge = e.bridges[e.active], driver = team.drivers[e.active];
    let dbg = {};
    try { dbg = bridge?.debug?.() ?? {}; } catch { dbg = { error: 'debug() threw' }; }
    const c = car.controls ?? {};
    const line = race.lineFor(car), plan = line.at(car.s);
    const target = Number.isFinite(dbg.targetSpeed) ? dbg.targetSpeed : null;
    if (this.focus !== focusId) { this.focus = focusId; this.trace = []; this.gg = []; this.intents = []; this.calls = []; }
    let vis = null;
    try { vis = bridge?.visualDebug?.() ?? null; } catch { vis = null; }
    const ai = AI_DRIVERS.find((d) => d.id === driver?.id);
    this.model = driver?.kind === 'human' ? null : lensModel(race, focusId, driver?.id, dbg, vis);
    this.tagName = `${ai?.short ?? driver?.short ?? 'AI'} · ${team.short}`;
    const t = race.time ?? 0;
    if (this.trace.length && t < this.trace.at(-1).t) this.trace = [];
    this.trace.push({ t, v: car.speed, plan: plan.speed, target, thr: c.throttle ?? 0, brk: c.brake ?? 0 });
    while (this.trace.length && t - this.trace[0].t > TRACE) this.trace.shift();
    this.gg.push([(car.ay ?? 0) / 9.81, (car.ax ?? 0) / 9.81]);
    if (this.gg.length > 40) this.gg.shift();

    const color = teamsById[team.id]?.color ?? '#fff';
    this.el.style.setProperty('--team', color);
    this.head.innerHTML = `<b>${esc(dbg.architecture ?? driver?.arch ?? driver?.id ?? 'AI')}</b><span>${esc(team.short)} · ${esc(driver?.name ?? '')}</span>`
      + `<div class="droster">${team.drivers.map((d, i) => `<i class="${i === e.active ? 'on' : ''}">${esc(d.short ?? d.name)}</i>`).join('')}</div>`;

    const chip = (label, value, cls = '') => value == null || value === '' ? '' : `<span class="${cls}"><small>${esc(label)}</small>${esc(String(value))}</span>`;
    const gov = e.governor;
    this.chips.innerHTML = [
      chip('intent', dbg.intent ?? dbg.state ?? null, 'hi'),
      chip('plan', dbg.planSource ?? null),
      chip('latency', bridge?.remote ? `${bridge.lastLatency.toFixed(1)} ms` : 'main'),
      chip('errors', bridge?.errors || null, 'bad'),
      chip('pace loss', e.strategist?.paceLoss ? `${e.strategist.paceLoss().toFixed(2)} s` : null),
      chip('limiter', gov?.active ? `k ${gov.k.toFixed(2)}` : null, 'warn'),
      chip('error', dbg.error ?? null, 'bad')
    ].join('');
    this.draw(car, c, plan, target, gov, color);
    if (this.model) {
      const m = this.model, last = this.intents.at(-1);
      if (last && t < last.t) this.intents = [];
      const prev = this.intents.at(-1);
      if (!prev || prev.intent !== m.intent || prev.focus !== (m.focus?.kind ?? null)) this.intents.push({ t, intent: m.intent, tone: m.tone, focus: m.focus?.kind ?? null });
      while (this.intents.length > 1 && t - this.intents[1].t > TRACE) this.intents.shift();
      const now = performance.now();
      if (now - this.mindAt > 100) { this.mindAt = now; this.drawMind(race, m, t); }
    }
    if (e.strategist) this.strategy(race, e, car, t);
    this.scope.update(race, focusId, this.model, color, teamsById);
    const avail = ['car', ...(this.model ? ['mind'] : []), ...(this.model?.path ? ['scope'] : []), ...(this.model?.radar ? ['radar'] : []), ...(e.strategist ? ['strat'] : []), ...(this.model?.log?.length ? ['log'] : [])];
    if (avail.join() !== this.avail.join()) { this.avail = avail; this.showTabs(); }
  }

  /**
   * Strategy tab: the focused car's pit-wall view, read from its own strategist on the main thread. The call it
   * holds for this lap and why, what the stop would contain, the fuel and tyre runway behind it, the team's style,
   * the calls it made lap by lap (and INTERCEPT v2's projected pit-or-stay places under a caution).
   */
  strategy(race, e, car, t) {
    const S = e.strategist, lap = car.race?.lap ?? 0, left = race.lapsLeft?.(car) ?? null;
    const plan = e.pitPlan ?? (S.boxThisLap ? S.plan : null), reason = S.reason || '';
    // Call history: one row per lap, updated while the lap's call changes.
    const last = this.calls.at(-1), row = { lap, box: Boolean(plan), reason, pit: Boolean(e.pit) };
    if (last && lap < last.lap) this.calls = [];
    if (!last || last.lap !== lap) this.calls.push(row); else Object.assign(last, row);
    while (this.calls.length > 10) this.calls.shift();
    const now = performance.now();
    if (now - this.stratAt < 200 || this.shown !== 'strat') return;
    this.stratAt = now;
    const id = car.wheels[0].tyre.compound, wear = Math.max(...car.wheels.map((w) => w.tyre.wear));
    const wpl = S.wearPerLap?.[id], fpl = S.fuelPerLap, fuelLaps = fpl ? car.fuel / fpl : null;
    const cliff = wpl ? Math.max(0, (WEAR_CLIFF - wear) / wpl) : null;
    const owed = Math.max(0, (S.format?.mandatoryStops ?? 0) - (S.stops ?? 0));
    const f1 = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
    const stat = (label, value, warn = false) => `<span class="${warn ? 'w' : ''}"><small>${esc(label)}</small>${esc(String(value))}</span>`;
    const call = e.pit ? 'IN THE PITS' : plan ? 'BOX THIS LAP' : 'STAY OUT';
    const what = plan ? [plan.litres > 0.5 ? `+${plan.litres.toFixed(0)} L` : 'no fuel', plan.tyres ? `${String(plan.compound ?? id).toUpperCase()} tyres` : 'keep tyres',
      plan.swap ? 'driver swap' : null, plan.repair ? 'repair' : null, plan.penalty ? `serve ${plan.penalty}` : null].filter(Boolean).join(' · ') : '';
    const st = S.style ?? {};
    const parts = [
      `<div class="mi" style="--tone:${plan || e.pit ? '#ffb02e' : '#3ddc84'}"><b>${call}</b><span>${esc(reason || (left != null && left <= 1 ? 'FINAL LAP' : 'no reason to stop'))}</span></div>`,
      what ? `<div class="mf" style="--fc:#ffb02e">${esc(what)}</div>` : '',
      S.request ? `<div class="mf" style="--fc:#4fd1e8">PIT WALL REQUEST · ${esc([S.request.compound, S.request.fuel != null ? `${S.request.fuel} L` : null, S.request.swap ? 'swap' : null].filter(Boolean).join(' · ') || 'box')}</div>` : '',
      `<h6>RACE</h6><div class="mn">${stat('laps left', left ?? '—')}${stat('stops', `${S.stops ?? 0}${owed ? ` · ${owed} owed` : ''}`, owed > 0 && left != null && left - 1 <= owed)}${stat('stint', `${S.stintLaps ?? 0} laps`)}${stat('swaps', S.swaps ?? 0)}</div>`,
      `<h6>FUEL</h6><div class="mn">${stat('tank', `${f1(car.fuel)} / ${TANK_LITRES} L`)}${stat('per lap', `${f1(fpl, 2)} L`)}${stat('range', `${f1(fuelLaps)} laps`, fuelLaps != null && left != null && fuelLaps < Math.min(left, 1.5))}${left != null && fpl ? stat('to the flag', `${f1(left * fpl - car.fuel, 1)} L`) : ''}</div>`,
      `<h6>TYRES · ${esc(String(id).toUpperCase())}</h6><div class="mn">${stat('worst wear', `${f1(wear * 100, 0)}%`, wear > WEAR_CLIFF - 0.08)}${stat('per lap', `${f1((wpl ?? 0) * 100, 1)}%`)}${stat('to the cliff', `${f1(cliff)} laps`, cliff != null && cliff < 1.5)}${S.fade?.[id] != null ? stat('fade', `×${f1(S.fade[id], 2)}`) : ''}</div>`,
      `<h6>MODEL</h6><div class="mn">${stat('lap ref', `${f1(S.lapRef)} s`)}${stat('stop loss', `${f1(S.stopLoss)} s`)}${S.paceLoss ? stat('pace loss', `${f1(S.paceLoss(), 2)} s`) : ''}${st.aggression != null ? stat('style', `agg ${f1(st.aggression, 2)} · undercut ${f1(st.undercut, 1)} · patience ${f1(st.patience, 2)}`) : ''}</div>`
    ];
    const cc = S.cautionCalls?.slice(-4) ?? [];
    if (cc.length) parts.push(`<h6>CAUTION CALLS · PROJECTED PIT / STAY</h6><div class="ml">${cc.map((c) => `<div>L${c.lap} ${String(c.kind).toUpperCase()} · ${(c.pit_ ?? c.worth) ? 'PIT' : 'STAY'}${c.pit_ != null && c.pit_ !== c.worth ? ' (held)' : ''} · P${c.pit.place} / P${c.stay.place}</div>`).join('')}</div>`);
    parts.push(`<h6>CALLS BY LAP</h6><div class="ml">${[...this.calls].reverse().map((c) => `<div>L${c.lap} · ${c.pit ? 'PITTING' : c.box ? 'BOX' : 'stay'}${c.reason ? ` · ${esc(c.reason)}` : ''}</div>`).join('')}</div>`);
    this.stratHead.innerHTML = `<small>STRATEGY · ${esc(this.tagName || e.team.short)}</small><p>${esc(S.constructor?.name ?? 'Strategist')}</p>`;
    this.stratBody.innerHTML = parts.join('');
  }

  drawMind(race, m, t) {
    const theme = m.theme?.color ?? '#fff';
    this.mind.style.setProperty('--arch', theme);
    this.mind.style.setProperty('--tone', toneColor(m.tone));
    const f = m.focus, fe = f && f.index >= 0 ? race.entries[f.index] : null;
    const fwd = fe ? (race.cars[f.index].race?.progress ?? 0) - (race.cars[this.focus].race?.progress ?? 0) : 0;
    const word = { attack: 'ATTACKING', follow: 'CHASING', defend: 'COVERING', alongside: 'SIDE BY SIDE WITH' }[f?.kind] ?? 'WATCHING';
    const small = (what) => `<small>${what} · ${esc(this.tagName)}</small>`;
    this.radarHead.innerHTML = small('RADAR'); this.logHead.innerHTML = small('RECENT EVENTS');
    this.mindHead.innerHTML = `${small('AI MIND')}<p>${esc(m.theme?.mind ?? '')}</p>`
      + `<div class="mi"><b>${esc(String(m.intent ?? '—').toUpperCase())}</b>${m.sub ? `<span>${esc(m.sub)}</span>` : ''}</div>`
      + (fe ? `<div class="mf${f.declared ? '' : ' inf'}" style="--fc:${toneColor(f.kind)}">${word} <b>${esc(fe.team.short)}</b> ${fwd >= 0 ? '+' : ''}${fwd.toFixed(0)} m${f.declared ? '' : ' · inferred'}${m.side ? ` · side ${m.side > 0 ? '+' : '−'}` : ''}</div>` : '<div class="mf inf">FREE AIR</div>')
      + (m.tags?.length ? `<div class="mt">${m.tags.map((x) => `<i>${esc(x)}</i>`).join('')}</div>` : '');
    // Intent timeline: the last seconds coloured by what the AI was doing (focus kind underneath).
    const g = this.timeline.getContext('2d'), W = 560, H = 64, X = (tt) => W * (1 - (t - tt) / TRACE);
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.05)'; g.fillRect(0, 18, W, 30);
    g.font = '600 18px "JetBrains Mono", monospace'; g.textBaseline = 'middle'; g.textAlign = 'left';
    this.intents.forEach((p, k) => {
      const x0 = Math.max(0, X(p.t)), x1 = k + 1 < this.intents.length ? X(this.intents[k + 1].t) : W;
      g.globalAlpha = .85; g.fillStyle = toneColor(p.tone); g.fillRect(x0, 18, Math.max(1, x1 - x0 - 1), 30);
      if (p.focus) { g.fillStyle = toneColor(p.focus); g.fillRect(x0, 52, Math.max(1, x1 - x0 - 1), 8); }
      g.globalAlpha = 1;
      if (x1 - x0 > 60) { g.fillStyle = '#000'; g.fillText(String(p.intent ?? '').toUpperCase().slice(0, Math.floor((x1 - x0 - 8) / 11)), x0 + 6, 34); }
    });
    g.fillStyle = 'rgba(255,255,255,.45)'; g.fillText(`INTENT · LAST ${TRACE} s`, 0, 8);
    this.drawRadar(race, m);
    // Options, controller internals and counters.
    const parts = [];
    if (m.flow) parts.push(this.flowHtml(m));
    const cands = (m.cands ?? []).filter((c) => Number.isFinite(c.score));
    if (cands.length) {
      const sc = cands.map((c) => c.score), lo = Math.min(...sc), hi = Math.max(...sc);
      parts.push(`<h6>OPTIONS · ${esc(m.candNote ?? 'scored')}</h6><div class="mc">${cands.map((c) => {
        const q = hi > lo ? (c.score - lo) / (hi - lo) : 1;
        return `<div class="${c.chosen ? 'on' : ''}"><span>${esc(c.label)}</span><i><b style="width:${(6 + 94 * q).toFixed(0)}%"></b></i><em>${esc(c.note || c.score.toFixed(0))}</em></div>`;
      }).join('')}</div>`);
    }
    if (m.gauges?.length) parts.push(`<h6>INSIDE THE CONTROLLER</h6><div class="mg">${m.gauges.map((x) => `<div><span>${esc(x.label)}</span><i><b style="width:${(x.value * 100).toFixed(0)}%;${x.color ? `background:${x.color}` : ''}"></b></i><em>${esc(x.text ?? '')}</em></div>`).join('')}</div>`);
    if (m.counters?.length) parts.push(`<div class="mn">${m.counters.map((x) => `<span><small>${esc(x.label)}</small>${esc(String(x.value))}</span>`).join('')}</div>`);
    this.mindBody.innerHTML = parts.join('');
    this.logBody.innerHTML = m.log?.length ? `<div class="ml">${m.log.map((x) => `<div>${esc(x)}</div>`).join('')}</div>` : '';
  }

  /**
   * ORACLE's move ladder: where the car is (racing line, in a tow, pulling out, diving, alongside), and the clock a move
   * is judged on: now → braking point → apex across the 4.5 s forecast, with how far short of an overlap each side is.
   */
  flowHtml(m) {
    const f = m.flow, steps = [['line', 'LINE'], ['tow', 'TOW'], ['pull', 'PULL-OUT'], ['dive', 'DIVE'], ['side', 'ALONGSIDE']];
    const X = (t) => `${(100 * Math.max(0, Math.min(1, t / f.H))).toFixed(1)}%`;
    const marks = [f.tb != null && `<b style="left:${X(f.tb)}"></b><em style="left:${X(f.tb)}">BRAKE ${f.tb.toFixed(1)} s</em>`,
      f.tA != null && f.tA !== f.tb && `<b class="ap" style="left:${X(f.tA)}"></b><em class="lo" style="left:${X(f.tA)}">APEX ${f.tA.toFixed(1)} s</em>`].filter(Boolean).join('');
    const short = f.short.map((q) => `<div class="${q.chosen ? 'on' : ''}"><span>${esc(q.label)}</span><em>${q.ok ? 'overlaps' : `${q.rel.toFixed(1)} m short`}</em></div>`).join('');
    return `<h6>MOVE</h6><div class="mflow">${steps.map(([id, t]) => `<i class="${id === f.stage ? 'on' : ''}">${t}</i>`).join('<u>›</u>')}</div>`
      + `<div class="mclock"><span>now</span>${marks}<span class="end">${f.H} s</span></div>${short ? `<div class="mshort">${short}</div>` : ''}`;
  }

  /**
   * Top-down radar in road coordinates for architectures that report one (m.radar): the road with the car and its
   * rivals, where each rival is expected to be, the lanes the planner weighed (chosen one bright) and any contact it
   * expects. Left on screen is left on the road.
   */
  drawRadar(race, m) {
    const cv = this.radarCv, r = m.radar;
    if (!r) return;
    const ahead = (r.rivals ?? []).reduce((m, v) => Math.max(m, v.d), 0), behind = (r.rivals ?? []).reduce((m, v) => Math.min(m, v.d), 0);
    const dMax = Math.max(35, Math.min(90, ahead * 1.3 + 12)), dMin = -Math.max(12, Math.min(30, -behind * 1.2 + 6));
    const g = cv.getContext('2d'), W = 560, H = 420, PX = 20, PY = H / (dMax - dMin), yMe = H * dMax / (dMax - dMin), theme = m.theme?.color ?? '#fff', tone = toneColor(m.tone);
    const X = (lat) => W / 2 - lat * PX, Y = (d) => yMe - d * PY, half = r.half ?? 7.5;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(8,10,14,.55)'; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(X(half), 0, 2 * half * PX, H);
    g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 3; g.beginPath(); g.moveTo(X(half), 0); g.lineTo(X(half), H); g.moveTo(X(-half), 0); g.lineTo(X(-half), H); g.stroke();
    g.font = '600 15px "JetBrains Mono", monospace'; g.textBaseline = 'middle'; g.lineWidth = 1;
    for (let d = Math.ceil(dMin / 10) * 10; d <= dMax; d += 10) {
      if (!d) continue;
      g.strokeStyle = 'rgba(255,255,255,.08)'; g.beginPath(); g.moveTo(0, Y(d)); g.lineTo(W, Y(d)); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.35)'; g.textAlign = 'left'; g.fillText(`${d > 0 ? '+' : ''}${d}`, 4, Y(d) - 8);
    }
    const poly = (pts, col, w, dash = [], a = 1) => {
      if (pts.length < 2) return;
      g.globalAlpha = a; g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash); g.beginPath();
      pts.forEach(([d, l], k) => (k ? g.lineTo(X(l), Y(d)) : g.moveTo(X(l), Y(d)))); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    };
    const box = (lat, d, col, a = 1) => { g.globalAlpha = a; g.fillStyle = col; g.fillRect(X(lat) - 1.96 * PX / 2, Y(d) - 4.56 * PY / 2, 1.96 * PX, 4.56 * PY); g.globalAlpha = 1; };
    // lanes weighed: the chosen one last so it sits on top
    for (const l of (r.lanes ?? []).filter((q) => !q.chosen)) poly(l.rp, theme, 2, [], .35);
    for (const l of (r.lanes ?? []).filter((q) => q.chosen)) { poly(l.rp, '#000', 7, [], .5); poly(l.rp, tone, 4); }
    // rivals: forecast path, body, label
    for (const v of r.rivals ?? []) {
      const col = v.kind === 'alongside' ? '#ff8f3d' : v.kind === 'ahead' ? '#ffb02e' : '#4f8cff', k = race.cars.findIndex((c) => c.id === v.id), name = race.entries[k]?.team?.short ?? `#${v.id}`;
      poly([[v.d, v.l], ...(v.rp ?? []).slice(1)], col, 2, [4, 4], .8);
      const e = v.rp?.at(-1); if (e) { g.fillStyle = col; g.beginPath(); g.arc(X(e[1]), Y(e[0]), 4, 0, 7); g.fill(); }
      box(v.l, v.d, col, .9);
      if (v.focus) { g.strokeStyle = tone; g.lineWidth = 3; g.strokeRect(X(v.l) - 1.96 * PX / 2 - 4, Y(v.d) - 4.56 * PY / 2 - 4, 1.96 * PX + 8, 4.56 * PY + 8); }
      g.fillStyle = '#fff'; g.textAlign = v.l > 0 ? 'right' : 'left';
      g.fillText(`${name} ${v.d >= 0 ? '+' : ''}${v.d.toFixed(0)} m`, X(v.l) + (v.l > 0 ? -1 : 1) * (1.96 * PX / 2 + 8), Y(v.d) - 6);
      g.fillStyle = 'rgba(255,255,255,.6)'; g.fillText(`${v.v - r.me.v >= 0 ? '+' : ''}${(v.v - r.me.v).toFixed(1)} m/s`, X(v.l) + (v.l > 0 ? -1 : 1) * (1.96 * PX / 2 + 8), Y(v.d) + 9);
    }
    box(r.me.l, 0, theme, 1);
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(X(r.me.l) - 1.96 * PX / 2, Y(0) - 4.56 * PY / 2, 1.96 * PX, 4.56 * PY);
    if (r.contact) {
      const cx = X(r.contact.l), cy = Y(r.contact.d); g.strokeStyle = '#ff3b3b'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(cx - 9, cy - 9); g.lineTo(cx + 9, cy + 9); g.moveTo(cx + 9, cy - 9); g.lineTo(cx - 9, cy + 9); g.stroke();
      g.fillStyle = '#ff3b3b'; g.textAlign = 'left'; g.fillText(`${r.contact.closing} m/s`, cx + 14, cy);
    }
    g.fillStyle = 'rgba(255,255,255,.55)'; g.textAlign = 'right'; g.fillText(`RADAR · ${r.cap != null ? `cap ${Math.round(r.cap * 3.6)} km/h` : 'no cap'}`, W - 6, 12);
  }

  draw(car, c, plan, target, gov, color) {
    const g = this.ctx;
    g.clearRect(0, 0, W, H);
    g.font = '600 10px "JetBrains Mono", monospace'; g.textBaseline = 'middle';
    const label = (txt, x, y, col = 'rgba(255,255,255,.45)', align = 'left') => { g.fillStyle = col; g.textAlign = align; g.fillText(txt, x, y); };

    // 1. Pedals and steering wheel.
    const pedal = (x, v, col, name) => {
      g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(x, 8, 16, 92);
      g.fillStyle = col; g.fillRect(x, 8 + 92 * (1 - clamp01(v)), 16, 92 * clamp01(v));
      label(name, x + 8, 110, 'rgba(255,255,255,.5)', 'center');
    };
    pedal(4, c.throttle, '#3ddc84', 'THR'); pedal(26, c.brake, '#ff4d4d', 'BRK');
    const sx = 96, sy = 56, sr = 38, steer = Math.max(-1, Math.min(1, -(c.steer ?? 0)));
    g.lineWidth = 6; g.strokeStyle = 'rgba(255,255,255,.1)';
    g.beginPath(); g.arc(sx, sy, sr, Math.PI * .75, Math.PI * 2.25); g.stroke();
    g.strokeStyle = color; g.beginPath();
    g.arc(sx, sy, sr, -Math.PI / 2 + Math.min(0, steer) * Math.PI * .75, -Math.PI / 2 + Math.max(0, steer) * Math.PI * .75); g.stroke();
    g.save(); g.translate(sx, sy); g.rotate(steer * Math.PI * .75);
    g.lineWidth = 3; g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(0, -sr + 10); g.lineTo(0, -sr - 4); g.stroke(); g.restore();
    label(`G${car.gear}`, sx, sy - 6, '#fff', 'center');
    label(`${kmh(car.speed)}`, sx, sy + 9, '#fff', 'center');
    label('STEER', sx, 110, 'rgba(255,255,255,.5)', 'center');

    // 2. G-G diagram with a fading trail.
    const gx = 222, gy = 56, gr = 44, scale = gr / 2;
    g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,.14)';
    for (const r of [1, 2]) { g.beginPath(); g.arc(gx, gy, r * scale, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(gx - gr, gy); g.lineTo(gx + gr, gy); g.moveTo(gx, gy - gr); g.lineTo(gx, gy + gr); g.stroke();
    this.gg.forEach(([lat, lon], i) => {
      const a = (i + 1) / this.gg.length, last = i === this.gg.length - 1;
      g.fillStyle = last ? '#fff' : `rgba(255,209,102,${a * .7})`;
      g.beginPath(); g.arc(gx + Math.max(-2.2, Math.min(2.2, lat)) * scale, gy - Math.max(-2.2, Math.min(2.2, lon)) * scale, last ? 4 : 2, 0, Math.PI * 2); g.fill();
    });
    label('G-G  1g/2g', gx, 110, 'rgba(255,255,255,.5)', 'center');

    // 3. Speed vs plan: bar with the line's planned speed and the AI's target.
    const by = 132, max = 90;
    label('SPEED', 4, by - 8);
    label(`${kmh(car.speed)} / plan ${kmh(plan.speed)}${target != null ? ` / tgt ${kmh(target)}` : ''} km/h`, W - 4, by - 8, 'rgba(255,255,255,.7)', 'right');
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(4, by, W - 8, 10);
    const over = car.speed > plan.speed + 1.5;
    g.fillStyle = over ? '#ffb02e' : '#4fd1e8'; g.fillRect(4, by, (W - 8) * clamp01(car.speed / max), 10);
    const tick = (v, col) => { g.fillStyle = col; g.fillRect(4 + (W - 8) * clamp01(v / max) - 1, by - 3, 3, 16); };
    tick(plan.speed, '#fff'); if (target != null) tick(target, '#ffd166');

    // 4. Speed trace: speed, planned speed, AI target; throttle/brake underneath.
    const ty = 162, th = 110, tb = 26, tr = this.trace, t1 = tr.at(-1)?.t ?? 0;
    g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(4, ty, W - 8, th + tb + 4);
    label(`LAST ${TRACE} s`, 8, ty + 8);
    const X = (t) => 4 + (W - 8) * (1 - (t1 - t) / TRACE), Y = (v) => ty + th - th * clamp01(v / max);
    for (const p of tr) {
      const x = X(p.t), w = Math.max(1, (W - 8) / (TRACE * 12));
      g.fillStyle = 'rgba(61,220,132,.55)'; g.fillRect(x, ty + th + 4 + tb * (1 - p.thr), w, tb * p.thr);
      g.fillStyle = 'rgba(255,77,77,.8)'; g.fillRect(x, ty + th + 4 + tb * (1 - p.brk), w, tb * p.brk);
    }
    const plot = (key, col, dash = []) => {
      g.setLineDash(dash); g.strokeStyle = col; g.lineWidth = key === 'v' ? 2 : 1.2; g.beginPath();
      let pen = false;
      for (const p of tr) { if (p[key] == null) { pen = false; continue; } pen ? g.lineTo(X(p.t), Y(p[key])) : g.moveTo(X(p.t), Y(p[key])); pen = true; }
      g.stroke(); g.setLineDash([]);
    };
    plot('plan', 'rgba(255,255,255,.45)', [4, 3]); plot('target', '#ffd166', [2, 2]); plot('v', '#4fd1e8');
    label('— speed', W - 120, ty + 8, '#4fd1e8'); label('-- plan', W - 64, ty + 8, 'rgba(255,255,255,.6)');

    // 5. Tyres: core temperature colour, wear fill, temperature figure.
    const ty2 = 316;
    label('TYRES', 4, ty2 - 6);
    const names = ['FL', 'FR', 'RL', 'RR'];
    car.wheels.forEach((w, i) => {
      const t = w.tyre, x = 30 + (i % 2) * 64, y = ty2 + 4 + Math.floor(i / 2) * 60, wear = clamp01(t.wear);
      g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(x, y, 28, 50);
      g.fillStyle = tempColor(t.core); g.globalAlpha = .9; g.fillRect(x, y + 50 * wear, 28, 50 * (1 - wear)); g.globalAlpha = 1;
      g.strokeStyle = 'rgba(255,255,255,.3)'; g.strokeRect(x + .5, y + .5, 27, 49);
      label(`${Math.round(t.core)}°`, i % 2 ? x + 34 : x - 4, y + 18, '#fff', i % 2 ? 'left' : 'right');
      label(`${Math.round((1 - wear) * 100)}%`, i % 2 ? x + 34 : x - 4, y + 32, 'rgba(255,255,255,.55)', i % 2 ? 'left' : 'right');
      label(names[i], x + 14, y + 25, 'rgba(0,0,0,.6)', 'center');
    });

    // 6. Tyre management meter: how much pace the governor is taking off to
    //    hold the tyres in their window (manage is a pace multiplier, 1 = flat out).
    const mx = 176, my = ty2 + 4;
    label('TYRE MGMT', mx, my + 2);
    const cut = gov && !gov.push ? Math.max(0, 1 - gov.manage) : 0;
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(mx, my + 12, W - mx - 4, 10);
    g.fillStyle = gov?.push ? '#3ddc84' : '#ffb02e'; g.fillRect(mx, my + 12, (W - mx - 4) * (gov?.push ? 1 : clamp01(cut / .08)), 10);
    label(gov ? (gov.push ? 'PUSH' : cut < .002 ? 'FLAT OUT' : `SAVING −${(cut * 100).toFixed(1)}% pace`) : '—', mx, my + 32, '#fff');
    if (gov?.hot != null) { label('HOTTEST CORE', mx, my + 52); label(`${gov.hot.toFixed(0)}°C`, mx, my + 66, tempColor(gov.hot)); }
    label('LINE', mx, my + 88);
    const off = car.lateral - (plan.offset ?? 0);
    label(`${off >= 0 ? '+' : ''}${off.toFixed(2)} m off`, mx, my + 102, Math.abs(off) > 1.5 ? '#ffb02e' : '#fff');
  }
}
