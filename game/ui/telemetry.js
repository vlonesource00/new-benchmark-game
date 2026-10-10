// Telemetry overlay: live classification with strategy columns, plus lap-time,
// fuel and tyre-wear charts built from per-lap history recorded on the client.
import { esc, fmtLap, fmtGap, compound, pct } from './format.js';
import { TANK_LITRES, WEAR_CLIFF } from '../core/rules.js';
import { RACE_CLASSES } from '../core/classes.js';
import { DEPLOY_MODES } from '../core/hybrid.js';

export class TelemetryLog {
  constructor() { this.history = new Map(); this.lastLap = new Map(); }
  reset() { this.history.clear(); this.lastLap.clear(); }
  /** Records one point per completed lap for every car. */
  record(snap) {
    for (const c of snap.cars) {
      const prev = this.lastLap.get(c.id);
      this.lastLap.set(c.id, c.lap);
      if (prev === undefined || c.lap === prev || !c.lastLap) continue;
      const h = this.history.get(c.id) ?? [];
      h.push({ lap: prev, time: c.lastLap, fuel: c.fuel, wear: Math.max(...c.wear), pit: Boolean(c.pit) || h.at(-1)?.stops !== c.stops, stops: c.stops, soc: c.hybrid ? c.hybrid.soc : null });
      this.history.set(c.id, h);
    }
  }
}

// Chart state survives the overlay's refreshes: the hovered lap (shared by every chart), the car under the pointer,
// a car pinned by clicking its line or its table row, and the class shown in a mixed field.
const ui = { el: null, hover: null, hoverChart: null, near: null, pin: null, cls: null, data: null, mouse: null, geo: null };

export function renderTelemetry(el, snap, log, ctx) {
  const { teamsById, focusId, trackLength } = ctx;
  const cars = [...snap.cars].sort((a, b) => a.position - b.position), leader = cars[0];
  const classes = [...new Set(cars.map((c) => c.raceClass ?? 'gt3'))], multi = classes.length > 1, hybrid = cars.some((c) => c.hybrid);
  if (ui.el !== el || !el.querySelector('.tel') || ui.hybrid !== hybrid) build(el, ctx, hybrid);
  ui.redraw = () => renderTelemetry(el, snap, log, ctx);
  if (!multi) ui.cls = null;
  else if (ui.cls !== 'all' && !classes.includes(ui.cls)) ui.cls = cars.find((c) => c.id === focusId)?.raceClass ?? classes[0];
  el.querySelector('.tel-filter').innerHTML = multi ? ['all', ...classes].map((k) => `<button data-cls="${k}" class="${ui.cls === k ? 'on' : ''}">${k === 'all' ? 'ALL' : esc(RACE_CLASSES[k]?.label ?? k)}</button>`).join('') : '';
  el.querySelector('thead').innerHTML = `<tr><th>POS</th>${multi ? '<th>CLASS</th>' : ''}<th>TEAM</th><th>DRIVER</th><th>GAP</th><th>LAST</th><th>BEST</th><th>TYRE</th><th>WEAR</th><th>FUEL</th>${hybrid ? '<th>HYBRID</th>' : ''}<th>STOPS</th><th>STINTS</th></tr>`;
  el.querySelector('tbody').innerHTML = cars.map((c) => {
    const t = teamsById[c.team];
    const down = trackLength ? Math.max(0, Math.floor((leader.progress - c.progress) / trackLength)) : 0;
    const cmp = compound(c.compound);
    const wear = Math.max(...c.wear);
    const bg = c.id === ui.pin ? 'rgba(255,255,255,.14)' : c.id === focusId ? 'rgba(255,255,255,.06)' : '';
    return `<tr data-car="${c.id}" style="cursor:pointer;${bg ? `background:${bg}` : ''}">
      <td class="t">${c.position}</td>${multi ? `<td>${classCell(c)}</td>` : ''}<td><span style="display:inline-block;width:4px;height:14px;background:${t.color};margin-right:6px;vertical-align:middle"></span>${esc(t.short)}</td>
      <td>${esc(c.driverName)}${c.coDriving ? ' <small style="color:var(--accent-2)">CO</small>' : ''}</td>
      <td>${c.pit ? 'PIT' : fmtGap(c.gap, c.position, down)}</td><td>${fmtLap(c.lastLap)}</td><td>${fmtLap(c.bestLap)}</td>
      <td><span style="color:${cmp.color}">${cmp.short}</span></td><td style="color:${wear >= WEAR_CLIFF ? 'var(--bad)' : 'inherit'}">${pct(wear / WEAR_CLIFF)}</td>
      <td>${c.fuel.toFixed(1)}L</td>${hybrid ? `<td>${hybridCell(c)}</td>` : ''}<td>${c.stops}</td><td>${stintBar(c, t, snap.laps)}</td></tr>`;
  }).join('');
  const shown = cars.filter((c) => !ui.cls || ui.cls === 'all' || (c.raceClass ?? 'gt3') === ui.cls);
  const series = shown.map((c) => ({ id: c.id, color: teamsById[c.team].color, name: `${teamsById[c.team].short} · ${c.driverName}`, focus: c.id === focusId, hybrid: Boolean(c.hybrid), pts: log.history.get(c.id) ?? [] }));
  ui.data = { series, laps: snap.laps };
  drawAll();
}

const CHARTS = {
  time: { title: 'LAP TIME', pick: (p) => (p.pit ? null : p.time), fmt: (v) => fmtLap(v), axis: (v) => fmtLap(v).slice(0, 6), order: 1, robust: true },
  fuel: { title: 'FUEL (L)', pick: (p) => p.fuel, fmt: (v) => `${v.toFixed(1)} L`, axis: (v) => v.toFixed(0), order: -1, range: () => [0, TANK_LITRES] },
  wear: { title: 'PEAK TYRE WEAR', pick: (p) => p.wear, fmt: (v) => pct(v / WEAR_CLIFF), axis: (v) => pct(v / WEAR_CLIFF), order: -1, range: () => [0, Math.max(WEAR_CLIFF * 1.15, 0.1)], marker: WEAR_CLIFF },
  soc: { title: 'HYBRID CHARGE', pick: (p) => p.soc, fmt: (v) => pct(v), axis: (v) => pct(v), order: -1, range: () => [0, 1], hybrid: true }
};
const idOf = (s) => (s !== '' && !Number.isNaN(Number(s)) ? Number(s) : s);

function build(el, ctx, hybrid) {
  ui.el = el; ui.hybrid = hybrid; ui.hover = null; ui.near = null; ui.mouse = null; ui.hoverChart = null;
  el.innerHTML = `
    <div class="modal tel">
      <div class="panel-head" style="margin-bottom:10px"><div><div class="kicker">Pit wall</div><h2>Telemetry</h2></div><button class="back" data-close>Close · T</button></div>
      <table><thead></thead><tbody></tbody></table>
      <div class="tel-bar"><div class="tel-filter"></div><small>Hover a chart to read every car on that lap · click a line or a row to pin a car</small></div>
      <div class="charts${hybrid ? ' four' : ''}">
        ${Object.entries(CHARTS).filter(([, c]) => !c.hybrid || hybrid).map(([k, c]) => `<div class="tel-chart"><div class="chart-t">${c.title}</div><canvas data-chart="${k}"></canvas><div class="tel-tip"></div></div>`).join('')}
      </div>
    </div>`;
  el.querySelector('[data-close]').addEventListener('click', () => ctx.close());
  el.querySelector('.tel-filter').addEventListener('click', (e) => { const b = e.target.closest('[data-cls]'); if (!b) return; ui.cls = b.dataset.cls; ui.hover = null; ui.redraw?.(); });
  el.querySelector('tbody').addEventListener('click', (e) => { const tr = e.target.closest('[data-car]'); if (!tr) return; const id = idOf(tr.dataset.car); ui.pin = ui.pin === id ? null : id; ui.redraw?.(); });
  for (const cv of el.querySelectorAll('canvas[data-chart]')) {
    cv.addEventListener('mousemove', (e) => { const r = cv.getBoundingClientRect(); ui.hoverChart = cv.dataset.chart; ui.mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; drawAll(); });
    cv.addEventListener('mouseleave', () => { ui.hover = null; ui.hoverChart = null; ui.near = null; ui.mouse = null; drawAll(); });
    cv.addEventListener('click', () => { if (ui.near == null) return; ui.pin = ui.pin === ui.near ? null : ui.near; ui.redraw?.(); });
  }
}

function drawAll() {
  if (!ui.el || !ui.data) return;
  const { series } = ui.data;
  // Pointer -> hovered lap and the car whose line is nearest, from the chart under the mouse (last frame's scales).
  if (ui.mouse && ui.hoverChart && ui.geo?.[ui.hoverChart]) {
    const geo = ui.geo[ui.hoverChart], cfg = CHARTS[ui.hoverChart];
    ui.hover = Math.max(1, Math.min(geo.maxLap, Math.round(geo.lapAt(ui.mouse.x))));
    let best = Infinity; ui.near = null;
    for (const s of series) {
      if (cfg.hybrid && !s.hybrid) continue;
      const p = s.pts.find((q) => q.lap === ui.hover), v = p ? cfg.pick(p) : null; if (!Number.isFinite(v)) continue;
      const d = Math.abs(geo.y(v) - ui.mouse.y); if (d < best) { best = d; ui.near = s.id; }
    }
    if (best > 28) ui.near = null;
  }
  const geo = {};
  for (const cv of ui.el.querySelectorAll('canvas[data-chart]')) {
    const k = cv.dataset.chart, cfg = CHARTS[k];
    geo[k] = chart(cv, cfg.hybrid ? series.filter((s) => s.hybrid) : series, cfg, ui.data.laps);
  }
  ui.geo = geo;
  for (const cv of ui.el.querySelectorAll('canvas[data-chart]')) tooltip(cv, cv.dataset.chart, CHARTS[cv.dataset.chart]);
}

function tooltip(cv, k, cfg) {
  const tip = cv.parentElement.querySelector('.tel-tip');
  if (ui.hoverChart !== k || ui.hover == null || !ui.geo[k] || !ui.mouse) { tip.style.display = 'none'; return; }
  const rows = ui.data.series.filter((s) => !cfg.hybrid || s.hybrid).map((s) => { const p = s.pts.find((q) => q.lap === ui.hover); return { s, p, v: p ? cfg.pick(p) : null }; })
    .filter((r) => r.p).sort((a, b) => (Number.isFinite(a.v) ? (Number.isFinite(b.v) ? (a.v - b.v) * cfg.order : -1) : 1));
  if (!rows.length) { tip.style.display = 'none'; return; }
  const ref = rows.find((r) => r.s.id === (ui.near ?? ui.pin))?.v;
  tip.innerHTML = `<b>LAP ${ui.hover}</b>` + rows.map((r, i) => {
    const hl = r.s.id === ui.near || r.s.id === ui.pin, val = Number.isFinite(r.v) ? cfg.fmt(r.v) : (r.p.pit ? 'PIT' : '—');
    const d = k === 'time' && Number.isFinite(ref) && Number.isFinite(r.v) && !hl ? ` <em>${r.v - ref >= 0 ? '+' : ''}${(r.v - ref).toFixed(2)}</em>` : '';
    return `<div class="${hl ? 'hl' : ''}"><i style="background:${r.s.color}"></i><span>${i + 1}. ${esc(r.s.name)}</span><span>${val}${d}${r.p.pit && Number.isFinite(r.v) ? ' <em>PIT</em>' : ''}</span></div>`;
  }).join('');
  tip.style.display = 'block';
  const tw = tip.offsetWidth || 240, w = cv.clientWidth;
  tip.style.left = `${Math.max(0, ui.mouse.x + 18 + tw > w ? ui.mouse.x - 18 - tw : ui.mouse.x + 18)}px`;
  tip.style.top = '24px';
}

function chart(canvas, series, cfg, laps) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 220;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d'); g.scale(dpr, dpr);
  const pick = cfg.pick, vals = series.flatMap((s) => s.pts.map(pick)).filter(Number.isFinite);
  const pad = { l: 52, r: 12, t: 10, b: 24 };
  g.font = '11px "JetBrains Mono", monospace'; g.fillStyle = 'rgba(255,255,255,.55)';
  if (!vals.length) { g.fillText('Waiting for the first lap…', pad.l, h / 2); return null; }
  let [lo, hi] = cfg.range ? cfg.range() : [Math.min(...vals), Math.max(...vals)];
  if (cfg.robust) {
    // Spins, out-laps and caution laps would squash the field: the scale stops a little past the 85th percentile
    // and slower laps are drawn clipped to the top edge.
    const sv = [...vals].sort((a, b) => a - b), q = sv[Math.floor((sv.length - 1) * 0.85)];
    hi = Math.min(hi, q + Math.max(1, (q - sv[0]) * 0.8));
    const m = Math.max(0.3, (hi - lo) * 0.08); lo -= m; hi += m;
  }
  const maxLap = Math.max(1, ...series.flatMap((s) => s.pts.map((p) => p.lap)));
  const span = Math.max(2, maxLap, Math.min(laps, maxLap + 1));
  const x = (lap) => pad.l + ((lap - 1) / (span - 1)) * (w - pad.l - pad.r);
  const lapAt = (px) => 1 + ((px - pad.l) / (w - pad.l - pad.r)) * (span - 1);
  const yRaw = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (h - pad.t - pad.b);
  const y = (v) => Math.max(pad.t, Math.min(h - pad.b, yRaw(v)));
  // Grid: five value lines and lap ticks along the bottom.
  g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const v = lo + (hi - lo) * i / 4, yy = yRaw(v);
    g.beginPath(); g.moveTo(pad.l, yy); g.lineTo(w - pad.r, yy); g.stroke();
    g.fillText(cfg.axis(v), 4, yy + 4);
  }
  const step = [1, 2, 5, 10, 20, 50, 100].find((s) => span / s <= 10) ?? 200;
  g.textAlign = 'center';
  for (let l = 1; l <= span; l += 1) {
    if (l !== 1 && l % step) continue;
    const xx = x(l); g.beginPath(); g.moveTo(xx, pad.t); g.lineTo(xx, h - pad.b); g.stroke(); g.fillText(`L${l}`, xx, h - 7);
  }
  g.textAlign = 'left';
  if (cfg.marker != null) { g.strokeStyle = 'rgba(255,59,59,.65)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(pad.l, yRaw(cfg.marker)); g.lineTo(w - pad.r, yRaw(cfg.marker)); g.stroke(); g.setLineDash([]); }
  if (ui.hover != null) { g.strokeStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.moveTo(x(ui.hover), pad.t); g.lineTo(x(ui.hover), h - pad.b); g.stroke(); }
  // Lines: the car under the pointer (else the pinned car, else the focused one) on top in full colour, the rest dimmed.
  const lead = ui.near ?? ui.pin, on = (s) => s.id === ui.near || s.id === ui.pin || (lead == null && s.focus);
  const rank = (s) => (s.id === ui.near ? 3 : s.id === ui.pin ? 2 : s.focus ? 1 : 0);
  for (const s of [...series].sort((a, b) => rank(a) - rank(b))) {
    const hot = on(s);
    g.strokeStyle = g.fillStyle = s.color; g.globalAlpha = hot ? 1 : lead != null ? 0.22 : 0.6; g.lineWidth = hot ? 2.8 : 1.6;
    g.beginPath(); let open = false;
    for (const p of s.pts) {
      const v = pick(p);
      if (!Number.isFinite(v)) { open = false; continue; }
      if (open) g.lineTo(x(p.lap), y(v)); else { g.moveTo(x(p.lap), y(v)); open = true; }
    }
    g.stroke();
    // A dot per lap; a pit lap is a ring.
    for (const p of s.pts) {
      const v = pick(p); if (!Number.isFinite(v)) continue;
      g.beginPath(); g.arc(x(p.lap), y(v), hot ? 3 : 2, 0, Math.PI * 2);
      if (p.pit) { g.lineWidth = 1.5; g.stroke(); } else g.fill();
    }
  }
  g.globalAlpha = 1;
  if (ui.hover != null) for (const s of series) {
    const p = s.pts.find((q) => q.lap === ui.hover), v = p ? pick(p) : null; if (!Number.isFinite(v)) continue;
    g.fillStyle = s.color; g.strokeStyle = '#0b0c10'; g.lineWidth = 2; g.beginPath(); g.arc(x(ui.hover), y(v), on(s) ? 5 : 3.5, 0, Math.PI * 2); g.stroke(); g.fill();
  }
  return { lapAt, y, maxLap };
}

function classCell(c) {
  const k = RACE_CLASSES[c.raceClass ?? 'gt3'];
  return `<span class="cls-tag" style="background:${k.color};color:${k.fg}">${k.label} P${c.classPosition ?? c.position}</span>`;
}

function hybridCell(c) {
  if (!c.hybrid) return '<span style="color:var(--dim)">—</span>';
  const soc = c.hybrid.soc, col = soc < 0.2 ? 'var(--bad)' : soc > 0.6 ? 'var(--good, #4cd964)' : 'var(--accent-2)';
  return `<span class="tel-soc"><i style="width:${(soc * 100).toFixed(0)}%;background:${col}"></i></span> ${pct(soc)} <small style="color:var(--dim)">${DEPLOY_MODES[c.hybrid.mode]?.label ?? ''}</small>`;
}

function stintBar(c, team, laps) {
  const stints = c.stints ?? [];
  return `<div class="stintbar">${stints.map((s, i) => {
    const to = s.toLap ?? c.lap, n = Math.max(0.3, to - s.fromLap + (s.toLap ? 1 : 0.5));
    const human = team.drivers[s.driver]?.kind === 'human';
    return `<i title="${esc(team.drivers[s.driver]?.name)} · L${s.fromLap}–${s.toLap ?? '…'}" style="width:${(n / laps) * 100}%;background:${human ? 'var(--accent)' : i % 2 ? team.color : 'rgba(255,255,255,.35)'}"></i>`;
  }).join('')}</div>`;
}
