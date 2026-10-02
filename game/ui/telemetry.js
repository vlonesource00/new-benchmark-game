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

export function renderTelemetry(el, snap, log, ctx) {
  const { teamsById, focusId, trackLength } = ctx;
  const cars = [...snap.cars].sort((a, b) => a.position - b.position), leader = cars[0];
  const multi = new Set(cars.map((c) => c.raceClass ?? 'gt3')).size > 1, hybrid = cars.some((c) => c.hybrid);
  el.innerHTML = `
    <div class="modal tel">
      <div class="panel-head" style="margin-bottom:10px"><div><div class="kicker">Pit wall</div><h2>Telemetry</h2></div><button class="back" data-close>Close · T</button></div>
      <table><thead><tr><th>POS</th>${multi ? '<th>CLASS</th>' : ''}<th>TEAM</th><th>DRIVER</th><th>GAP</th><th>LAST</th><th>BEST</th><th>TYRE</th><th>WEAR</th><th>FUEL</th>${hybrid ? '<th>HYBRID</th>' : ''}<th>STOPS</th><th>STINTS</th></tr></thead><tbody>
      ${cars.map((c) => {
        const t = teamsById[c.team];
        const down = trackLength ? Math.max(0, Math.floor((leader.progress - c.progress) / trackLength)) : 0;
        const cmp = compound(c.compound);
        const wear = Math.max(...c.wear);
        return `<tr style="${c.id === focusId ? 'background:rgba(255,255,255,.06)' : ''}">
          <td class="t">${c.position}</td>${multi ? `<td>${classCell(c)}</td>` : ''}<td><span style="display:inline-block;width:4px;height:14px;background:${t.color};margin-right:6px;vertical-align:middle"></span>${esc(t.short)}</td>
          <td>${esc(c.driverName)}${c.coDriving ? ' <small style="color:var(--accent-2)">CO</small>' : ''}</td>
          <td>${c.pit ? 'PIT' : fmtGap(c.gap, c.position, down)}</td><td>${fmtLap(c.lastLap)}</td><td>${fmtLap(c.bestLap)}</td>
          <td><span style="color:${cmp.color}">${cmp.short}</span></td><td style="color:${wear >= WEAR_CLIFF ? 'var(--bad)' : 'inherit'}">${pct(wear / WEAR_CLIFF)}</td>
          <td>${c.fuel.toFixed(1)}L</td>${hybrid ? `<td>${hybridCell(c)}</td>` : ''}<td>${c.stops}</td><td>${stintBar(c, t, snap.laps)}</td></tr>`;
      }).join('')}
      </tbody></table>
      <div class="charts">
        <div><div class="chart-t">LAP TIME</div><canvas data-chart="time"></canvas></div>
        <div><div class="chart-t">FUEL (L)</div><canvas data-chart="fuel"></canvas></div>
        <div><div class="chart-t">PEAK TYRE WEAR</div><canvas data-chart="wear"></canvas></div>
        ${hybrid ? '<div><div class="chart-t">HYBRID CHARGE</div><canvas data-chart="soc"></canvas></div>' : ''}
      </div>
    </div>`;
  el.querySelector('[data-close]').addEventListener('click', () => ctx.close());
  el.querySelector('.charts').classList.toggle('four', hybrid);
  const series = cars.map((c) => ({ color: teamsById[c.team].color, focus: c.id === focusId, pts: log.history.get(c.id) ?? [] }));
  chart(el.querySelector('[data-chart="time"]'), series, (p) => p.pit ? null : p.time, snap.laps, null, (v) => fmtLap(v).slice(0, 6));
  chart(el.querySelector('[data-chart="fuel"]'), series, (p) => p.fuel, snap.laps, [0, TANK_LITRES], (v) => v.toFixed(0));
  chart(el.querySelector('[data-chart="wear"]'), series, (p) => p.wear, snap.laps, [0, Math.max(WEAR_CLIFF * 1.15, 0.1)], (v) => pct(v / WEAR_CLIFF), WEAR_CLIFF);
  if (hybrid) chart(el.querySelector('[data-chart="soc"]'), series.filter((s, i) => cars[i].hybrid), (p) => p.soc, snap.laps, [0, 1], (v) => pct(v));
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

function chart(canvas, series, pick, laps, range, label, marker = null) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 190;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d'); g.scale(dpr, dpr);
  const vals = series.flatMap((s) => s.pts.map(pick)).filter(Number.isFinite);
  const pad = { l: 44, r: 8, t: 8, b: 18 };
  g.font = '11px "JetBrains Mono", monospace'; g.fillStyle = 'rgba(255,255,255,.45)';
  if (!vals.length) { g.fillText('Waiting for the first lap…', pad.l, h / 2); return; }
  let [lo, hi] = range ?? [Math.min(...vals), Math.max(...vals)];
  if (!range) { const m = Math.max(0.2, (hi - lo) * 0.12); lo -= m; hi += m; }
  const x = (lap) => pad.l + ((lap - 1) / Math.max(1, laps - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (h - pad.t - pad.b);
  g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
  for (let i = 0; i <= 3; i += 1) {
    const v = lo + (hi - lo) * i / 3, yy = y(v);
    g.beginPath(); g.moveTo(pad.l, yy); g.lineTo(w - pad.r, yy); g.stroke();
    g.fillText(label(v), 2, yy + 4);
  }
  if (marker !== null) { g.strokeStyle = 'rgba(255,59,59,.6)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(pad.l, y(marker)); g.lineTo(w - pad.r, y(marker)); g.stroke(); g.setLineDash([]); }
  for (const s of [...series].sort((a, b) => a.focus - b.focus)) {
    g.strokeStyle = s.color; g.globalAlpha = s.focus ? 1 : 0.45; g.lineWidth = s.focus ? 2.4 : 1.3;
    g.beginPath(); let open = false;
    for (const p of s.pts) {
      const v = pick(p);
      if (!Number.isFinite(v)) { open = false; continue; }
      if (open) g.lineTo(x(p.lap), y(v)); else { g.moveTo(x(p.lap), y(v)); open = true; }
    }
    g.stroke();
  }
  g.globalAlpha = 1;
}
