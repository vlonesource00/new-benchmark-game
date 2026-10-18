// Engine voices per car class. Each profile is a physical description the
// engine DSP (worklet.js) plays: cylinder count and firing order (with the
// bank each firing exhausts into), the rev range, header and tailpipe lengths,
// pulse sharpness, airbox formants, turbo and valvetrain detail.
//
// Teams run one engine: a car's profile comes from its team, so team-mates
// sound alike and different makes sound different. The sim's rpm range
// (SIM_IDLE..SIM_MAX) is mapped onto each engine's own idle..redline, so a
// high-revving flat six screams where a big V8 bellows at the same shift
// point.
//
// Tuning: `gain` levels the profiles against each other (set by measuring the
// rendered loudness at full load); `exhLP` is how open the exhaust sounds;
// `crack` is the combustion rasp; `blow` is the exhaust pulse width in crank
// degrees (wider = rounder and bassier); `header`/`tail` are pipe lengths in
// metres (they place the resonances); `cylVar` is the cylinder-to-cylinder
// spread that gives the note its lumpy half orders.

export const SIM_IDLE = 1100, SIM_MAX = 8300;

const even = (n, step) => Array.from({ length: n }, (_, i) => i * step);
const V8_CROSS = { firing: even(8, 90), bankOf: [0, 1, 0, 1, 1, 0, 1, 0], cyl: 8, banks: 2 };   // 1-5-4-8-6-3-7-2: uneven per bank, the burble
const V8_FLAT = { firing: even(8, 90), bankOf: [0, 1, 0, 1, 0, 1, 0, 1], cyl: 8, banks: 2 };    // banks alternate: even per bank, the scream
const FLAT6 = { firing: even(6, 120), bankOf: [0, 1, 0, 1, 0, 1], cyl: 6, banks: 2 };
const V10 = { firing: even(10, 72), bankOf: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1], cyl: 10, banks: 2 };
const V6 = { firing: even(6, 120), bankOf: [0, 1, 0, 1, 0, 1], cyl: 6, banks: 2 };
const I6 = { firing: even(6, 120), bankOf: [0, 1, 0, 1, 0, 1], cyl: 6, banks: 1 };

const base = { hRefl: 0.4, tRefl: -0.6, hDamp: 0.5, tDamp: 0.32, rough: 0.045, cylVar: 0.07, muffQ: 1.1, spread: 0.5, pops: 0.7, turbo: 0, mech: 0.4, orders: [14, 22.5] };

const DEFS = {
  // ---- GT3 ----
  'gt-v8-cross': { ...base, ...V8_CROSS, label: '6.3 L NA cross-plane V8', idle: 950, redline: 7500,
    header: [0.74, 0.78], tail: [1.95, 2.1], blow: 74, crack: 0.16, cylVar: 0.1, drive: 1.35, exhLP: 4600,
    muffHz: 105, muffDb: 5, intakeHz: 250, intake2Hz: 760, intake: 0.55, pops: 1, orders: [12, 20], gain: 0.85 },
  'gt-f6': { ...base, ...FLAT6, label: '4.2 L NA flat six', idle: 1200, redline: 9400,
    header: [0.56, 0.58], tail: [1.25, 1.3], blow: 54, crack: 0.3, cylVar: 0.06, drive: 1.6, exhLP: 7200,
    muffHz: 165, muffDb: 3, intakeHz: 340, intake2Hz: 1150, intake: 0.75, mech: 0.9, orders: [18, 27, 36], gain: 0.94 },
  'gt-v10': { ...base, ...V10, label: '5.2 L NA V10', idle: 1100, redline: 8700,
    header: [0.5, 0.52], tail: [1.5, 1.56], blow: 50, crack: 0.28, cylVar: 0.05, drive: 1.7, exhLP: 7800,
    muffHz: 140, muffDb: 3, intakeHz: 380, intake2Hz: 1300, intake: 0.6, mech: 0.6, orders: [20, 31], gain: 0.51 },
  'gt-v8-flat': { ...base, ...V8_FLAT, label: '5.5 L NA flat-plane V8', idle: 1100, redline: 8600,
    header: [0.6, 0.61], tail: [1.6, 1.66], blow: 56, crack: 0.3, cylVar: 0.06, drive: 1.6, exhLP: 6800,
    muffHz: 130, muffDb: 4, intakeHz: 320, intake2Hz: 1000, intake: 0.65, mech: 0.5, orders: [16, 24], gain: 1.0 },
  'gt-i6-tt': { ...base, ...I6, label: '3.0 L twin-turbo straight six', idle: 1000, redline: 7300,
    header: [0.46, 0.46], tail: [2.2, 2.2], hRefl: 0.32, tRefl: -0.5, blow: 76, crack: 0.08, drive: 1.2, exhLP: 3500,
    muffHz: 95, muffDb: 6, intakeHz: 300, intake2Hz: 950, intake: 0.3, turbo: 1, turboHz: [1400, 3600], pops: 0.6, mech: 0.5, orders: [12, 21], gain: 0.59 },
  'gt-v6-tt': { ...base, ...V6, label: '3.0 L twin-turbo 120° V6', idle: 1050, redline: 8000,
    header: [0.42, 0.43], tail: [1.7, 1.76], blow: 62, crack: 0.14, drive: 1.4, exhLP: 4400,
    muffHz: 120, muffDb: 4, intakeHz: 330, intake2Hz: 1050, intake: 0.35, turbo: 1.1, turboHz: [1700, 4400], pops: 0.9, mech: 0.6, orders: [15, 26], gain: 0.85 },
  // ---- GTP / LMDh hybrids (each also carries the rear-axle motor whine) ----
  // Prototype engines are stressed members behind a turbine or a tuned, silenced system: smoother
  // pulses (wider `blow`), little combustion rasp, a deeper muffler body than the GT3s.
  'gtp-v8-tt': { ...base, ...V8_FLAT, label: '4.6 L twin-turbo V8 hybrid', idle: 1100, redline: 8800,
    header: [0.5, 0.5], tail: [1.5, 1.52], blow: 66, crack: 0.07, rough: 0.035, drive: 1.2, exhLP: 4300,
    muffHz: 120, muffDb: 5.5, intakeHz: 330, intake2Hz: 1000, intake: 0.35, turbo: 0.7, turboHz: [1500, 3800], pops: 0.6, mech: 0.35, orders: [16, 25], hybrid: true, gain: 1.07 },
  'gtp-v8-na': { ...base, ...V8_CROSS, label: '5.5 L NA V8 hybrid', idle: 1000, redline: 8400,
    header: [0.7, 0.74], tail: [1.7, 1.82], blow: 68, crack: 0.12, rough: 0.04, cylVar: 0.08, drive: 1.35, exhLP: 5200,
    muffHz: 110, muffDb: 6, intakeHz: 280, intake2Hz: 860, intake: 0.6, pops: 0.8, mech: 0.35, orders: [14, 22], hybrid: true, gain: 0.84 },
  'gtp-v6-tt': { ...base, ...V6, label: '2.4 L twin-turbo V6 hybrid', idle: 1300, redline: 9500,
    header: [0.38, 0.39], tail: [1.3, 1.32], blow: 62, crack: 0.1, rough: 0.035, drive: 1.3, exhLP: 4800,
    muffHz: 145, muffDb: 4.5, intakeHz: 370, intake2Hz: 1200, intake: 0.35, turbo: 0.9, turboHz: [1800, 4600], pops: 0.7, mech: 0.4, orders: [18, 30], hybrid: true, gain: 1.0 }
};

export const ENGINE_PROFILES = Object.freeze(Object.fromEntries(Object.entries(DEFS).map(([id, p]) => [id, Object.freeze({ id, ...p })])));

const POOLS = {
  gt: ['gt-v8-cross', 'gt-f6', 'gt-v10', 'gt-v8-flat', 'gt-i6-tt', 'gt-v6-tt'],
  lmdh: ['gtp-v8-tt', 'gtp-v8-na', 'gtp-v6-tt']
};

function hash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/** The profile id for a car: by class, then by team (team-mates share an engine). */
export function profileIdFor(car) {
  if (car.audioProfile && ENGINE_PROFILES[car.audioProfile]) return car.audioProfile;
  const pool = POOLS[car.classId] ?? POOLS[car.spec?.key] ?? POOLS.gt;
  const key = car.team?.id ?? car.team?.name ?? car.id ?? 0;
  return pool[hash(key) % pool.length];
}

/** Sim rpm -> this engine's rpm. */
export function engineRpm(profile, simRpm) {
  const f = (simRpm - SIM_IDLE) / (SIM_MAX - SIM_IDLE);
  return profile.idle + Math.max(-0.1, f) * (profile.redline - profile.idle);
}
