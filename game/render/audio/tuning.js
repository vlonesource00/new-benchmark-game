// Player sound tuning: what the in-game sound tuner (ui/audio-tuner.js) can change, stored in
// localStorage and applied by AudioEngine.setTuning(). Mix values are absolute LEVELS; engine values
// are multipliers on each class's profiles (profiles.js), so 1 is always "as designed".

export const TUNING_KEY = 'pe.audioTune';

/** [LEVELS key, label, max, test sound] grouped for the panel (test sounds: AudioEngine.audition). The default comes from LEVELS itself. */
export const MIX_GROUPS = [
  ['Your car', [
    ['engine', 'Engine', 1.5, 'rev'],
    ['exhaustOnboard', 'Exhaust (cockpit)', 1.5, 'rev'],
    ['intakeOnboard', 'Intake (cockpit)', 3, 'rev'],
    ['intakeOutside', 'Intake (chase / TV)', 1.5, 'rev'],
    ['whine', 'Gearbox whine', 0.04, 'coast'],
    ['mgu', 'Hybrid motor', 0.15, 'hybrid'],
    ['pops', 'Pops & bangs', 3, 'pops']
  ]],
  ['Other cars', [
    ['rival', 'Nearby cars', 1.5, 'flyby'],
    ['field', 'Distant pack', 1.5, 'pack']
  ]],
  ['Tyres & track', [
    ['tyres', 'Tyre squeal', 1.5, 'slide'],
    ['scrub', 'Tyre scrub', 3, 'scrub'],
    ['surface', 'Kerbs, gravel, grass', 1.2, 'surface'],
    ['road', 'Road rumble', 0.2, 'cruise'],
    ['wind', 'Wind', 0.25, 'cruise']
  ]],
  ['Effects & world', [
    ['impacts', 'Crashes', 3, 'crash'],
    ['fx', 'Effects bus', 1.5, 'crash'],
    ['ambience', 'Circuit ambience', 1.5, 'circuit'],
    ['ambienceMenu', 'Menu ambience', 1.5, 'menuBed'],
    ['rain', 'Rain', 1.2, 'rain'],
    ['reverb', 'Reverb', 1.5, 'reverb'],
    ['ui', 'Interface beeps', 1, 'ui']
  ]]
];

/** [profile field, label, min, max, test sound]: multipliers applied to every engine of a class. */
export const ENGINE_CONTROLS = [
  ['gain', 'Volume', 0.3, 2, 'rev'],
  ['exhLP', 'Brightness', 0.5, 1.6, 'rev'],
  ['crack', 'Rasp', 0, 2.5, 'rev'],
  ['blow', 'Body (pulse width)', 0.7, 1.4, 'rev'],
  ['intake', 'Intake roar', 0, 2.5, 'rev'],
  ['turbo', 'Turbo', 0, 2.5, 'rev'],
  ['pops', 'Pop rate', 0, 3, 'pops'],
  ['cylVar', 'Lumpiness', 0, 4, 'rev']
];

export const ENGINE_CLASSES = [['gt', 'GT3'], ['lmdh', 'GTP / LMDh']];

export const emptyTuning = () => ({ levels: {}, engines: { gt: {}, lmdh: {} } });

export function loadTuning(key = TUNING_KEY) {
  try {
    const t = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (t && typeof t === 'object') return { levels: { ...t.levels }, engines: { gt: { ...t.engines?.gt }, lmdh: { ...t.engines?.lmdh } } };
  } catch { /* storage unavailable or corrupt */ }
  return emptyTuning();
}

export function saveTuning(t, key = TUNING_KEY) {
  try { localStorage.setItem(key, JSON.stringify(t)); } catch { /* storage unavailable */ }
}

/** A profile with its class multipliers applied (the original when nothing is tuned). */
export function tuneProfile(profile, mult) {
  if (!mult || !Object.keys(mult).length) return profile;
  const p = { ...profile };
  for (const [k, m] of Object.entries(mult)) if (Number.isFinite(m) && Number.isFinite(p[k])) p[k] = p[k] * m;
  return Object.freeze(p);
}
