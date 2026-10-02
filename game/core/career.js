// Driver career, iRacing-style: a licence class with a Safety Rating, and an
// iRating that moves with every official result. Stored locally; the same
// numbers would ride on a player account once races go online.
//
// - Safety Rating (0.00–4.99) moves with corners per incident (CPI) against the
//   target of the licence class: clean racing promotes, crashing demotes.
// - iRating is a multi-player Elo: each finish is scored against every rival
//   with the pairwise win probability iRacing uses (scale 1600 / ln 2).
// - Official races are rated and licence-gated; hosted races are free and unrated.

const KEY = 'pe.career';
const BR = 1600 / Math.LN2;

export const LICENSES = Object.freeze([
  { id: 'R', name: 'ROOKIE', color: '#e04a3c', cpi: 20 },
  { id: 'D', name: 'CLASS D', color: '#f08a24', cpi: 30 },
  { id: 'C', name: 'CLASS C', color: '#e8c21c', cpi: 42 },
  { id: 'B', name: 'CLASS B', color: '#3cae4c', cpi: 56 },
  { id: 'A', name: 'CLASS A', color: '#2f76db', cpi: 75 }
]);
export const licenseById = (id) => LICENSES.find((l) => l.id === id) ?? LICENSES[0];
const rank = (id) => LICENSES.findIndex((l) => l.id === id);

/** Minimum licence for an official race in each format. */
export const FORMAT_LICENSE = Object.freeze({ sprint: 'R', custom: 'R', classic: 'D', marathon: 'C' });
export function meetsLicense(profile, formatId) { return rank(profile.license) >= rank(FORMAT_LICENSE[formatId] ?? 'R'); }

/** Official races match the field to your rating, like iRacing splits do. */
export function difficultyForRating(ir) {
  return ir < 1150 ? 'rookie' : ir < 1900 ? 'amateur' : ir < 2700 ? 'pro' : ir < 3700 ? 'expert' : 'alien';
}

const FRESH = { iRating: 1350, sr: 2.5, license: 'R', classRaces: 0, starts: 0, wins: 0, top5: 0, poles: 0, laps: 0, incidents: 0, dq: 0, history: [] };
export function loadCareer() {
  try { return { ...FRESH, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...FRESH }; }
}
export function saveCareer(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ } }

// Stable per-driver numbers so an AI keeps its rating from race to race.
function hash(str) { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
const AI_BASE = { rookie: 900, amateur: 1500, pro: 2300, expert: 3100, alien: 4300 };
export function aiRating(driverId, difficultyId) {
  return Math.round((AI_BASE[difficultyId] ?? 2300) + (hash(driverId) - .5) * 700);
}
export function aiLicense(driverId, rating) {
  const cls = rating < 1200 ? 'D' : rating < 2000 ? 'C' : rating < 2800 ? 'B' : 'A';
  return { license: cls, sr: +(2 + hash(driverId + 'sr') * 2.9).toFixed(2) };
}

/** Strength of field: the iRacing-style exponential mean of the ratings. */
export function strengthOfField(ratings) {
  if (!ratings.length) return 0;
  return Math.round(-BR * Math.log(ratings.reduce((a, r) => a + Math.exp(-r / BR), 0) / ratings.length));
}

/** Probability that a driver rated `a` finishes ahead of one rated `b`. */
function beats(a, b) {
  const ea = Math.exp(-a / BR), eb = Math.exp(-b / BR);
  return (1 - ea) * eb / ((1 - eb) * ea + (1 - ea) * eb);
}

/** iRating change for one driver given everyone's rating and finishing position (1-based). */
export function iRatingDelta(me, field) {
  const n = field.length; if (n < 2) return 0;
  const expected = field.reduce((a, o) => a + (o === me ? 0 : beats(me.rating, o.rating)), 0);
  const actual = field.reduce((a, o) => a + (o === me ? 0 : me.position < o.position ? 1 : me.position === o.position ? .5 : 0), 0);
  return Math.round((actual - expected) * 200 / (n - 1) * Math.min(1.6, 1 + (n - 2) / 10));
}

/** Safety Rating change from incidents over the corners raced. */
export function srDelta(license, corners, incidents) {
  if (corners < 4) return 0;
  const cpi = corners / Math.max(.5, incidents), target = licenseById(license).cpi;
  return +Math.max(-1, Math.min(.6, .12 * Math.log2(cpi / target) * Math.min(1, corners / 60))).toFixed(2);
}

/**
 * Applies one race to the profile. `result`: { official, position, field: [{rating, position, human}],
 * incidents, laps, corners, dq, track, format, sof }. Returns the change summary.
 */
export function recordRace(profile, result) {
  const before = { iRating: profile.iRating, sr: profile.sr, license: profile.license };
  const me = result.field.find((f) => f.human);
  const dIr = result.official && me ? iRatingDelta(me, result.field) : 0;
  const dSr = result.official ? srDelta(profile.license, result.corners, result.incidents) : 0;
  profile.iRating = Math.max(100, profile.iRating + dIr);
  profile.sr = +Math.max(0, Math.min(4.99, profile.sr + dSr)).toFixed(2);
  let promoted = false, demoted = false;
  if (result.official) {
    profile.classRaces++;
    const r = rank(profile.license);
    if (profile.sr >= 4 && r < LICENSES.length - 1 && profile.classRaces >= 2) { profile.license = LICENSES[r + 1].id; profile.sr = +(profile.sr - 1).toFixed(2); profile.classRaces = 0; promoted = true; }
    else if (profile.sr < 1 && r > 0) { profile.license = LICENSES[r - 1].id; profile.sr = +(profile.sr + 1.5).toFixed(2); profile.classRaces = 0; demoted = true; }
  }
  profile.starts++; profile.laps += result.laps; profile.incidents += result.incidents;
  if (!result.dq && result.position === 1) profile.wins++;
  if (!result.dq && result.position <= 5) profile.top5++;
  if (result.dq) profile.dq++;
  profile.history = [{ time: Date.now(), track: result.track, format: result.format, official: result.official, position: result.position, field: result.field.length, incidents: result.incidents, dq: result.dq, sof: result.sof, dIr, dSr }, ...profile.history].slice(0, 30);
  saveCareer(profile);
  return { before, after: { iRating: profile.iRating, sr: profile.sr, license: profile.license }, dIr, dSr, promoted, demoted };
}

/** "B 3.41" style licence string. */
export const licenseText = (license, sr) => `${license} ${Number(sr).toFixed(2)}`;
