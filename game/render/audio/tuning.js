// Player sound tuning: what the in-game sound tuner (ui/audio-tuner.js) can change, stored in
// localStorage and applied by AudioEngine.setTuning(). Mix values are absolute LEVELS; engine values
// are multipliers on each class's profiles (profiles.js), so 1 is always "as designed".

export const TUNING_KEY = 'pe.audioTune';

/** [LEVELS key, label, max, hint] grouped for the panel. The default comes from LEVELS itself. */
export const MIX_GROUPS = [
  ['Your car', [
    ['engine', 'Engine', 1.5],
    ['exhaustOnboard', 'Exhaust (cockpit)', 1.5],
    ['intakeOnboard', 'Intake (cockpit)', 3],
    ['intakeOutside', 'Intake (chase / TV)', 1.5],
    ['whine', 'Gearbox whine', 0.04],
    ['mgu', 'Hybrid motor', 0.15],
    ['pops', 'Pops & bangs', 3]
  ]],
  ['Other cars', [
    ['rival', 'Nearby cars', 1.5],
    ['field', 'Distant pack', 1.5]
  ]],
  ['Tyres & track', [
    ['tyres', 'Tyre squeal', 1.5],
    ['scrub', 'Tyre scrub', 3],
    ['surface', 'Kerbs, gravel, grass', 1.2],
    ['road', 'Road rumble', 0.2],
    ['wind', 'Wind', 0.25]
  ]],
  ['Effects & world', [
    ['impacts', 'Crashes', 3],
    ['fx', 'Effects bus', 1.5],
    ['ambience', 'Circuit ambience', 1.5],
    ['ambienceMenu', 'Menu ambience', 1.5],
    ['rain', 'Rain', 1.2],
    ['reverb', 'Reverb', 1.5],
    ['ui', 'Interface beeps', 1]
  ]]
];

/** [profile field, label, min, max]: multipliers applied to every engine of a class. */
export const ENGINE_CONTROLS = [
  ['gain', 'Volume', 0.3, 2],
  ['exhLP', 'Brightness', 0.5, 1.6],
  ['crack', 'Rasp', 0, 2.5],
  ['blow', 'Body (pulse width)', 0.7, 1.4],
  ['intake', 'Intake roar', 0, 2.5],
  ['turbo', 'Turbo', 0, 2.5],
  ['pops', 'Pop rate', 0, 3],
  ['cylVar', 'Lumpiness', 0, 4]
];

export const ENGINE_CLASSES = [['gt', 'GT3'], ['lmdh', 'GTP / LMDh']];

export const emptyTuning = () => ({ levels: {}, engines: { gt: {}, lmdh: {} } });

export function loadTuning() {
  try {
    const t = JSON.parse(localStorage.getItem(TUNING_KEY) ?? 'null');
    if (t && typeof t === 'object') return { levels: { ...t.levels }, engines: { gt: { ...t.engines?.gt }, lmdh: { ...t.engines?.lmdh } } };
  } catch { /* storage unavailable or corrupt */ }
  return emptyTuning();
}

export function saveTuning(t) {
  try { localStorage.setItem(TUNING_KEY, JSON.stringify(t)); } catch { /* storage unavailable */ }
}

/** A profile with its class multipliers applied (the original when nothing is tuned). */
export function tuneProfile(profile, mult) {
  if (!mult || !Object.keys(mult).length) return profile;
  const p = { ...profile };
  for (const [k, m] of Object.entries(mult)) if (Number.isFinite(m) && Number.isFinite(p[k])) p[k] = p[k] * m;
  return Object.freeze(p);
}
