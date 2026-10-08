import { StintModel } from '../../apex/src/stintmodel.js';
import { COMPOUNDS, TYRE_HEAT, WEAR_CLIFF, BASELINE } from '../../../game/core/rules.js';
import DATA from '../data/stints.json' with { type: 'json' };

// An incompatible tyre update must use the game's live planner rather than
// silently treating old lap/temperature measurements as current RAZOR data.
export function stintPriorsMatch(meta = DATA.meta) {
  return meta?.wearCliff === WEAR_CLIFF
    && Object.keys(BASELINE).every(key => meta.baseline?.[key] === BASELINE[key])
    && Object.keys(TYRE_HEAT).every(key => meta.classHeat?.[key] === TYRE_HEAT[key])
    && Object.entries(COMPOUNDS).every(([id, c]) => {
      const values = meta.compounds?.[id];
      return values?.[0] === c.grip && values[1] === c.wear && values[2] === c.optimum && values[3] === c.heat;
    });
}

export class RazorStintModel extends StintModel {
  constructor(trackId, classId, cal) {
    super(trackId, classId, cal);
    const source = stintPriorsMatch() && DATA[trackId]?.[classId];
    this.tables = source ? Object.fromEntries(Object.entries(source).map(([id, sets]) => {
      const unpack = samples => {
        const rows = samples.map(([t, wear, core, dw]) => ({ t, wear, core, dw }));
        // A sample clamped by a dead tyre under-records its wear demand. Keep
        // the last un-clamped ratio for later ages, as the roll model intends.
        const live = rows.findLast(row => row.wear < 0.9 && row.dw > 0)?.dw ?? rows[0].dw;
        for (const row of rows) if (row.wear >= 0.96) row.dw = live;
        return rows;
      };
      return [id, { rows: unpack(sets.rows), warm: unpack(sets.warm) }];
    })) : null;
    this.ok = Boolean(this.tables); this.cache.clear();
    if (this.ok) this.fitTime();
  }
  referenceTime(compound) {
    const table = this.tables[compound];
    return Math.min(...table.rows.slice(1).map(row => row.t), ...table.warm.slice(1).map(row => row.t));
  }
}
