// Small formatting helpers shared by every screen.
import { COMPOUNDS, TYRES, WEAR_CLIFF } from '../core/rules.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function fmtLap(s) {
  if (!Number.isFinite(s) || s <= 0) return '—:——.———';
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r.toFixed(3).padStart(6, '0')}`;
}

export function fmtClock(s) {
  if (!Number.isFinite(s)) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = Math.floor(s % 60);
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(r).padStart(2, '0')}`;
}

export function fmtGap(g, position, lapsDown = 0) {
  if (position === 1) return 'LEADER';
  if (lapsDown >= 1) return `+${lapsDown} LAP${lapsDown > 1 ? 'S' : ''}`;
  if (!Number.isFinite(g)) return '—';
  return `+${g.toFixed(g < 10 ? 3 : 1)}`;
}

export const compound = (id) => TYRES[id] ?? COMPOUNDS.medium;
export const compoundBadge = (id, size = 22) => {
  const c = compound(id);
  return `<span class="compound" style="border-color:${c.color};width:${size}px;height:${size}px">${c.short}</span>`;
};

/** Green → amber → red as wear approaches the cliff. */
export function wearColor(w) {
  const t = Math.min(1, w / WEAR_CLIFF);
  const hue = 130 - 130 * t;
  return `hsl(${hue.toFixed(0)} 78% ${w >= WEAR_CLIFF ? 44 : 52}%)`;
}

/** Blue when cold, green in the window, red when overheated (°C surface). */
export function tempColor(t) {
  if (!Number.isFinite(t)) return 'rgba(255,255,255,.2)';
  if (t < 70) return '#4aa8ff';
  if (t < 110) return '#3ddc84';
  if (t < 125) return '#ffb020';
  return '#ff3b3b';
}

export const pct = (v) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
