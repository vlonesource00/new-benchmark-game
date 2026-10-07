import STINT from '../data/stint.json' with { type: 'json' };
import { tyreGrip } from '../../../game/engine/sim/tyre.js';
import { COMPOUNDS, WEAR_CLIFF } from '../../../game/core/rules.js';
import { clamp } from './math.js';

const COMPOUND_IDS = ['soft', 'medium', 'hard'];
const WARM = 88, COLD = 72;

/**
 * What a set of tyres does lap by lap under APEX, per compound. The model is the game's own physics at lap granularity:
 *   wear gain per lap   = measured ratio (data/stint.json) x the host strategist's wear prior for this race length x live correction
 *   core temperature    = measured per lap of age
 *   lap time            = T(g) of the lap-average grip g of the worst wheel (tyre formula on core, pressure and wear),
 *                         T measured for this track and class on the same data
 * `adapt` carries the live corrections (what the car actually did against what this predicted).
 */
export class StintModel {
  constructor(trackId, classId, cal) {
    this.cal = cal; this.trackId = trackId; this.classId = classId;
    const t = STINT[trackId]?.[classId];
    this.tables = t && COMPOUND_IDS.every((c) => t[c]?.rows?.length > 3) ? t : null;
    this.ok = Boolean(this.tables);
    this.transit = STINT.pit?.[trackId]?.[classId]?.transit ?? 24;
    this.adapt = { wear: 1, time: 1, core: 0 };
    this.cache = new Map();
    if (this.ok) this.fitTime();
  }
  prior(c) { return WEAR_CLIFF * COMPOUNDS[c].wear / this.cal.tyreLaps; }
  /** Lap-average grip of the worst wheel for a (core, wear) trajectory over one lap. */
  grip(c, core0, wear0, core1, wear1) {
    const k = COMPOUNDS[c], G = (core, wear) => tyreGrip({ core, optimum: k.optimum, pressure: (1.65 + 1.01325) * ((core + 273.15) / 297.15) - 1.01325, wear, gripScale: k.grip }, 3300);
    return 0.5 * (G(core0, wear0) + G(core1, wear1));
  }
  /** Lap time against lap-average grip, from every measured lap after the first of every compound (monotone, piecewise linear). */
  fitTime() {
    const pts = [];
    for (const c of COMPOUND_IDS) {
      const rows = this.tables[c].rows;
      for (let i = 1; i < rows.length; i++) pts.push([this.grip(c, rows[i - 1].core, rows[i - 1].wear, rows[i].core, rows[i].wear), rows[i].t]);
    }
    pts.sort((a, b) => a[0] - b[0]);
    // isotonic in g: lap time must not rise with grip. Pool adjacent violators.
    const xs = [], ys = [], ws = [];
    for (const [x, y] of pts) { xs.push(x); ys.push(y); ws.push(1); while (ys.length > 1 && ys.at(-2) < ys.at(-1)) { const n = ys.length, w = ws[n - 2] + ws[n - 1], v = (ys[n - 2] * ws[n - 2] + ys[n - 1] * ws[n - 1]) / w; xs[n - 2] = (xs[n - 2] * ws[n - 2] + xs[n - 1] * ws[n - 1]) / w; ys[n - 2] = v; ws[n - 2] = w; xs.pop(); ys.pop(); ws.pop(); } }
    this.gx = xs; this.gy = ys;
  }
  timeAt(g) {
    const xs = this.gx, ys = this.gy, n = xs.length;
    if (g <= xs[0]) { const s = (ys[1] - ys[0]) / Math.max(1e-6, xs[1] - xs[0]); return ys[0] + s * (g - xs[0]); }
    if (g >= xs[n - 1]) { const s = (ys[n - 1] - ys[n - 2]) / Math.max(1e-6, xs[n - 1] - xs[n - 2]); return ys[n - 1] + s * (g - xs[n - 1]); }
    let i = 1; while (xs[i] < g) i++;
    const f = (g - xs[i - 1]) / Math.max(1e-9, xs[i] - xs[i - 1]);
    return ys[i - 1] + (ys[i] - ys[i - 1]) * f;
  }
  /**
   * Predicted laps of a set of `c`, starting at lap age `age0` from the state (wear0, core0): returns { t[k], wear[k], core[k] } for the next k = 1..count laps.
   * With no state given it is a fresh warm set (after a stop) or a fresh cold one (race start).
   */
  roll(c, count, { age0 = 0, wear0 = 0, core0 = WARM } = {}) {
    const rows = this.tables[c].rows, K = rows.length, prior = this.prior(c), a = this.adapt;
    const t = [], wear = [], core = []; let w = wear0, cc = core0;
    for (let k = 1; k <= count; k++) {
      const row = rows[Math.min(age0 + k, K) - 1];
      // beyond the measured ages the wear gain keeps the last ratio that was not clamped by a dead tyre
      let ratio = row.dw; if (age0 + k > K) ratio = rows[K - 1].dw;
      const w1 = Math.min(1, w + Math.max(0, ratio) * prior * a.wear), c1 = Math.max(this.cal ? 60 : 60, row.core + a.core);
      t.push(this.timeAt(this.grip(c, cc, w, c1, w1)) * a.time); wear.push(w1); core.push(c1);
      w = w1; cc = c1;
    }
    return { t, wear, core };
  }
  /** Cached roll of a fresh warm set for DP. */
  fresh(c, count, cold = false) {
    const key = `${c}|${count}|${cold}|${this.adapt.wear.toFixed(3)}|${this.adapt.time.toFixed(4)}|${this.adapt.core.toFixed(1)}`;
    let r = this.cache.get(key); if (!r) { if (this.cache.size > 64) this.cache.clear(); r = this.roll(c, count, { core0: cold ? COLD : WARM }); this.cache.set(key, r); }
    return r;
  }
}
export { COMPOUND_IDS, WARM, COLD };
