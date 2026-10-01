// Live AI debugger (B): what the focused car's active controller is thinking.
// AI seats run on workers, so their `debug()` is relayed with each control
// reply while this panel is open (AsyncSeats.wantDebug).
import { esc } from './format.js';

const MAX_ROWS = 22;

function fmt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (v == null) return 'â€”';
  return String(v).slice(0, 40);
}

/** Flattens nested stats into [key, value] rows, skipping big arrays and buffers. */
function flatten(obj, prefix = '', out = [], depth = 0) {
  if (!obj || typeof obj !== 'object') return out;
  for (const key of Object.keys(obj)) {
    if (out.length >= MAX_ROWS) break;
    const v = obj[key], name = prefix ? `${prefix}.${key}` : key;
    if (v && typeof v === 'object') {
      if (ArrayBuffer.isView(v) || v instanceof Map) continue;
      if (Array.isArray(v)) { if (v.length <= 4 && v.every((x) => typeof x !== 'object')) out.push([name, v.map(fmt).join(' ')]); continue; }
      if (depth < 2) flatten(v, name, out, depth + 1);
    } else out.push([name, fmt(v)]);
  }
  return out;
}

const bar = (label, x, color) => `<div class="dbar"><span>${label}</span><i><b style="width:${Math.round(Math.max(0, Math.min(1, x)) * 100)}%;background:${color}"></b></i><em class="mono">${Math.round(x * 100)}</em></div>`;

export class AiDebugPanel {
  constructor(parent) {
    this.el = document.createElement('div');
    this.el.className = 'aidebug';
    this.el.hidden = true;
    parent.append(this.el);
  }
  get open() { return !this.el.hidden; }
  toggle(on = !this.open) { this.el.hidden = !on; return on; }

  update(race, focusId, teamsById) {
    if (!this.open || !race) return;
    const e = race.entries[focusId], car = race.cars[focusId];
    if (!e || !car) return;
    const team = e.team, bridge = e.bridges[e.active], driver = team.drivers[e.active];
    let dbg = {};
    try { dbg = bridge?.debug?.() ?? {}; } catch { dbg = { error: 'debug() threw' }; }
    const { architecture, planSource, controllerCadence, intent, state, targetSpeed, stats, ...rest } = dbg;
    const c = car.controls ?? {};
    const roster = team.drivers.map((d, i) => `<span class="${i === e.active ? 'on' : ''}">${esc(d.short ?? d.name)} Â· ${i === e.active ? 'DRIVING' : 'STANDING BY'}</span>`).join('');
    const head = [
      ['plan', planSource], ['cadence', controllerCadence], ['intent', intent], ['state', state],
      ['target', Number.isFinite(targetSpeed) ? `${Math.round(targetSpeed * 3.6)} km/h` : undefined],
      ['speed', `${Math.round(car.speed * 3.6)} km/h Â· G${car.gear}`],
      ['latency', bridge?.remote ? `${bridge.lastLatency.toFixed(1)} ms (worker)` : 'main thread'],
      ['errors', bridge?.errors ?? 0],
      ['governor', e.governor?.active ? `k ${e.governor.k.toFixed(2)}` : 'off'],
      ['tyre mgmt', e.governor ? `${e.governor.push ? 'PUSH' : `${Math.round(e.governor.manage * 100)}%`} · core ${e.governor.hot.toFixed(0)}°` : '—'],
      ['pace loss', e.strategist?.paceLoss ? `${e.strategist.paceLoss().toFixed(2)} s/lap` : '—']
    ].filter(([, v]) => v !== undefined && v !== null && v !== '');
    const rows = flatten({ ...rest, ...(stats && typeof stats === 'object' ? stats : {}) });
    this.el.style.setProperty('--team', teamsById[team.id]?.color ?? '#fff');
    this.el.innerHTML = `
      <div class="dh"><b>AI DEBUG</b><span>${esc(team.short)} Â· ${esc(driver?.name ?? '')}</span></div>
      <div class="darch">${esc(architecture ?? driver?.arch ?? driver?.id ?? '')}</div>
      <div class="roster">${roster}</div>
      ${bar('THR', c.throttle ?? 0, '#3ddc84')}${bar('BRK', c.brake ?? 0, '#ff4d4d')}
      <div class="dbar"><span>STR</span><i class="mid"><b style="left:${50 + Math.min(50, Math.max(-50, -(c.steer ?? 0) * 50))}%"></b></i><em class="mono">${fmt(c.steer ?? 0)}</em></div>
      <dl>${head.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(fmt(v))}</dd>`).join('')}</dl>
      ${rows.length ? `<div class="dsub">PLANNER</div><dl class="stats">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
      <div class="dfoot">B close Â· Tab next car</div>`;
  }
}
