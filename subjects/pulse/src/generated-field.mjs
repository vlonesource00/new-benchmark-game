import { createHash } from 'node:crypto';
import { timingProfile } from '../tools/timing-profiles.mjs';

// Generated field v2 (2026-10-12). Whole-lap starts at reference-lap states,
// mixed rival AIs, traffic ahead, same-class pressure, sudden and standing
// hazards, and solo laps. Rivals: APEX, RAZOR, Gemini v4 and TEMPEST stayed on
// road in the s1 rival survey; INTERCEPT GT rivals left it unprovoked.
export const RIVAL_POOL = Object.freeze(['apex', 'razor', 'gemini-supreme-v4', 'tempest']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rng = seed => { let s = seed >>> 0; return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 2 ** 32; }; };
const round = (value, scale = 10) => Math.round(value * scale) / scale;
const at = (profile, s) => profile.bins[Math.floor((((s % profile.length) + profile.length) % profile.length) / profile.bin) % profile.bins.length];

export function generateField({ seed, train, development, finalTest, lmdh, gt }) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff
    || ![train, development, finalTest].every(n => Number.isInteger(n) && n >= 8 && n <= 1024))
    throw Error('Generated field counts must be 8–1024 per split; seed must be uint32');
  if (lmdh.length !== gt.length) throw Error('Reference profiles must share a track');
  const edge = lmdh.halfWidth - 1.2, cases = [], families = new Set();
  const splitKeys = [['train', train, 0x46545231], ['development', development, 0x46444531], ['final-test', finalTest, 0x46465431]];
  for (const [split, count, salt] of splitKeys) {
    const draw = rng(seed ^ salt), pick = list => list[Math.floor(draw() * list.length)], u = (a, b) => a + draw() * (b - a);
    const lane = (profile, s, spread = .7) => round(Math.max(-edge, Math.min(edge, at(profile, s).lateral + u(-spread, spread))), 100);
    for (let i = 0; i < count; i++) {
      const family = ['traffic', 'traffic', 'traffic', 'hazard', 'traffic', 'solo', 'race', 'hazard', 'traffic', 'solo'][i % 10];
      const start = round(u(0, lmdh.length)), me = at(lmdh, start);
      const settings = { track: lmdh.track, classId: 'lmdh', weather: 'clear', seed: Math.floor(draw() * 0x7fffffff), start,
        lateral: lane(lmdh, start, .8), yawOffset: round(u(-.01, .01), 10000), speed: round(me.speed * u(.85, 1)) };
      let field = [], requirements;
      const traffic = (n, from) => { let gap = from;
        for (let k = 0; k < n; k++) { gap += k ? u(18, 70) : 0; const s = start + gap;
          field.push({ driver: pick(RIVAL_POOL), classId: 'gt', gap: round(gap), lateral: lane(gt, s), speed: round(at(gt, s).speed * u(.88, .98)), hazard: null, stopAt: null }); } };
      if (family === 'traffic') {
        traffic(1 + Math.floor(draw() * 4), u(25, 120));
        if (draw() < .3) { const s = start - u(15, 60); field.push({ driver: pick(RIVAL_POOL), classId: 'lmdh', gap: round(s - start), lateral: lane(lmdh, s), speed: round(at(lmdh, s).speed * u(.93, 1)), hazard: null, stopAt: null }); }
        requirements = { encountersCleared: 1, unpassedTraffic: 0 };
      } else if (family === 'hazard') {
        const gap = u(60, 260), s = start + gap, sudden = draw() < .5;
        field.push({ driver: pick(RIVAL_POOL), classId: 'gt', gap: round(gap), lateral: sudden ? lane(gt, s) : round(u(-edge, edge), 100),
          speed: sudden ? round(at(gt, s).speed * u(.88, .98)) : 0, hazard: pick(['stopped', 'spun']), stopAt: sudden ? round(u(1, 8)) : 0 });
        // Extra traffic runs ahead of the hazard; a car close behind a sudden stop
        // makes a rival pile-up, not a PULSE hazard reaction.
        if (draw() < .5) traffic(1, gap + u(30, 90));
        requirements = { hazardsCleared: 1, unpassedTraffic: 0 };
      } else if (family === 'race') {
        for (let k = 0, gap = u(12, 50); k < 1 + Math.floor(draw() * 2); k++, gap += u(20, 50)) { const s = start + gap;
          field.push({ driver: pick(RIVAL_POOL), classId: 'lmdh', gap: round(gap), lateral: lane(lmdh, s), speed: round(at(lmdh, s).speed * u(.9, .98)), hazard: null, stopAt: null }); }
        requirements = {};
      } else requirements = { validFullLaps: 1 };
      Object.assign(settings, family === 'solo' ? { fixture: 'solo', seconds: 130 } : { fixture: 'field', field, seconds: 70 });
      const { seed: _seed, seconds: _seconds, ...physical } = settings, physicalFamily = hash(physical);
      if (families.has(physicalFamily)) throw Error('Duplicate generated physical encounter');
      families.add(physicalFamily);
      const profile = pick(['frame-120', 'frame-60', 'frame-30', 'lag-1', 'lag-2', 'jitter']);
      Object.assign(settings, timingProfile(profile), { scheduleSeed: Math.floor(draw() * 0xffffffff) });
      cases.push({ id: `${split}-${String(i + 1).padStart(3, '0')}-${family}`, split, family, profile, physicalFamily, settings,
        checkpointDistance: family === 'solo' ? 4500 : 2600, requirements });
    }
  }
  return { format: 'pulse-generated-field-v3', seed, counts: { train, development, finalTest }, rivalPool: RIVAL_POOL, cases,
    finalTestRule: 'Freeze the selected model and evaluation rules before running final-test. Do not tune or train from final-test outcomes.',
    scope: 'Harbor Ring, clear weather, GTP on soft tyres. Whole-lap starts at reference-lap states; mixed-AI GT traffic, GTP pressure, standing and sudden hazards, solo laps.' };
}
