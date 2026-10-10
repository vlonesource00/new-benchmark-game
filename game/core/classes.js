// Race classes and multiclass fields, iRacing IMSA-style: GTP hybrid
// prototypes and GT3 cars share the track, start in class groups (GTP ahead),
// and are classified, rated and coloured per class.
import { PACE_PROFILES } from './pace-profiles.js';
import { AI_DRIVERS } from './teams.js';

export const RACE_CLASSES = Object.freeze({
  gtp: { id: 'gtp', label: 'GTP', name: 'GTP HYBRID PROTOTYPE', car: 'lmdh', color: '#f2c230', fg: '#111', pace: 1.14, ai: ['solstice', 'gemini-supreme-v4', 'claude-revolution', 'next-racer', 'apex', 'razor', 'tempest'] },
  gt3: { id: 'gt3', label: 'GT3', name: 'GT3', car: 'gt', color: '#e0443a', fg: '#fff', pace: 1, ai: null }
});
export const classOf = (team) => RACE_CLASSES[team?.raceClass] ?? RACE_CLASSES.gt3;
export const classForCar = (car) => (car.classId === 'lmdh' ? RACE_CLASSES.gtp : RACE_CLASSES.gt3);

/** Field options for the setup screen. */
export const FIELDS = Object.freeze({
  gt3: { id: 'gt3', label: 'GT3', classes: ['gt3'] },
  gtp: { id: 'gtp', label: 'GTP', classes: ['gtp'] },
  multi: { id: 'multi', label: 'GTP + GT3', classes: ['gtp', 'gt3'] }
});

/** GTP cars in a multiclass field of n: the chosen count, else ~40%; at least one car in each class. */
export const gtpSplit = (n, gtpCount = null) => Math.max(1, Math.min(n - 1, Math.round(gtpCount ?? n * 0.4)));

/** Reference speed profile for a class: the GT reference scaled to the class's pace. */
export function classProfile(track, carClass) {
  const base = PACE_PROFILES[track.id ?? track.name]; if (!base) return null;
  const cls = Object.values(RACE_CLASSES).find((c) => c.car === carClass);
  const f = cls?.pace ?? 1;
  return f === 1 ? base : { ...base, lap: base.lap / f, v: base.v.map((x) => x * f) };
}

/**
 * Splits drawn teams into classes. In a multiclass field `gtpCount` teams (by
 * default ~40%, always at least one of each class) are GTP and grid ahead. GTP seats are driven only by AIs
 * that drive a prototype properly; the player's own team runs the class picked.
 */
export function assignClasses(teams, fieldId = 'gt3', playerClass = 'gt3', rand = Math.random, gtpCount = null) {
  const field = FIELDS[fieldId] ?? FIELDS.gt3;
  const human = (t) => t.drivers.some((d) => d.kind === 'human');
  let out;
  if (field.classes.length === 1) out = teams.map((t) => ({ ...t, raceClass: field.classes[0] }));
  else {
    const nGtp = gtpSplit(teams.length, gtpCount);
    const player = teams.find(human);
    const order = [...teams].sort((a, b) => a.grid - b.grid);
    const gtp = new Set();
    if (player && playerClass === 'gtp') gtp.add(player);
    for (const t of order) { if (gtp.size >= nGtp) break; if (t !== player) gtp.add(t); }
    out = teams.map((t) => ({ ...t, raceClass: gtp.has(t) ? 'gtp' : 'gt3' }));
  }
  // Prototype-capable AIs only in GTP cars; the class colour leads the livery tag.
  for (const t of out) {
    const cls = RACE_CLASSES[t.raceClass]; t.classId = cls.car;
    if (!cls.ai) continue;
    t.drivers = t.drivers.map((d) => {
      if (d.kind === 'human' || cls.ai.includes(d.id)) return d;
      const id = cls.ai[Math.floor(rand() * cls.ai.length)];
      const roster=AI_DRIVERS.find(ai=>ai.id===id);
      return { ...d, id, name:roster.name,short:roster.short,arch:roster.arch };
    });
  }
  // Class groups on the grid: GTP first, each class keeping its drawn order.
  const rank = (t) => field.classes.indexOf(t.raceClass);
  return out.sort((a, b) => rank(a) - rank(b) || a.grid - b.grid).map((t, grid) => ({ ...t, grid }));
}

/**
 * Race grid from a qualifying classification: classes keep their grid groups
 * (fastest class first) and each group is ordered by best lap. Cars without a
 * time line up at the back of their class in their drawn order.
 */
export function gridFromQualifying(teams, results) {
  const best = new Map(results.map((r) => [r.team, r.bestLap ?? Infinity]));
  const groups = [...new Set(teams.map((t) => t.raceClass ?? 'gt3'))];
  return [...teams]
    .sort((a, b) => groups.indexOf(a.raceClass ?? 'gt3') - groups.indexOf(b.raceClass ?? 'gt3') || best.get(a.id) - best.get(b.id) || a.grid - b.grid)
    .map((t, grid) => ({ ...t, grid, qualifyingLap: Number.isFinite(best.get(t.id)) ? best.get(t.id) : null }));
}
