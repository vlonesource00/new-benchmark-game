import { createHash } from 'node:crypto';
import { timingProfile } from '../tools/timing-profiles.mjs';
import { RIVAL_POOL } from './generated-field.mjs';

// Generated duels v1 (2026-10-13). Same-class, same-pace racing: PULSE starts 8-35 m behind one or two GTP rivals
// running at its own reference speed, sometimes with a GTP pressing from behind, and must complete a pass within
// 90 s. In the five-lap race card PULSE ran within 30 m behind a rival for ~60% of the race and asked for a side
// in under 10% of those rows; the field suite's race family has no pass requirement and its traffic runs ~6 m/s
// slower, so same-pace overtakes never had to be learned.
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rng = seed => { let s = seed >>> 0; return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 2 ** 32; }; };
const round = (value, scale = 10) => Math.round(value * scale) / scale;
const at = (profile, s) => profile.bins[Math.floor((((s % profile.length) + profile.length) % profile.length) / profile.bin) % profile.bins.length];

export function generateDuels({ seed, train, development, finalTest, lmdh }) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff
    || ![train, development, finalTest].every(n => Number.isInteger(n) && n >= 8 && n <= 1024))
    throw Error('Generated duel counts must be 8–1024 per split; seed must be uint32');
  const edge = lmdh.halfWidth - 1.2, cases = [], families = new Set();
  const splitKeys = [['train', train, 0x44545231], ['development', development, 0x44444531], ['final-test', finalTest, 0x44465431]];
  for (const [split, count, salt] of splitKeys) {
    const draw = rng(seed ^ salt), pick = list => list[Math.floor(draw() * list.length)], u = (a, b) => a + draw() * (b - a);
    const lane = (s, spread = .7) => round(Math.max(-edge, Math.min(edge, at(lmdh, s).lateral + u(-spread, spread))), 100);
    for (let i = 0; i < count; i++) {
      const start = round(u(0, lmdh.length)), pace = u(.97, 1);
      const settings = { track: lmdh.track, classId: 'lmdh', weather: 'clear', seed: Math.floor(draw() * 0x7fffffff), start,
        lateral: lane(start, .8), yawOffset: round(u(-.01, .01), 10000), speed: round(at(lmdh, start).speed * pace) };
      const field = [];
      for (let k = 0, gap = u(8, 35); k < (draw() < .6 ? 1 : 2); k++, gap += u(10, 25)) { const s = start + gap;
        field.push({ driver: pick(RIVAL_POOL), classId: 'lmdh', gap: round(gap), lateral: lane(s), speed: round(at(lmdh, s).speed * u(.97, 1)), hazard: null, stopAt: null }); }
      if (draw() < .25) { const s = start - u(15, 30);
        field.push({ driver: pick(RIVAL_POOL), classId: 'lmdh', gap: round(s - start), lateral: lane(s), speed: round(at(lmdh, s).speed * u(.97, 1)), hazard: null, stopAt: null }); }
      Object.assign(settings, { fixture: 'field', field, seconds: 90 });
      const { seed: _seed, seconds: _seconds, ...physical } = settings, physicalFamily = hash(physical);
      if (families.has(physicalFamily)) throw Error('Duplicate generated physical duel');
      families.add(physicalFamily);
      const profile = pick(['frame-120', 'frame-60', 'frame-30', 'lag-1', 'lag-2', 'jitter']);
      Object.assign(settings, timingProfile(profile), { scheduleSeed: Math.floor(draw() * 0xffffffff) });
      cases.push({ id: `duel-${split}-${String(i + 1).padStart(3, '0')}`, split, family: 'duel', profile, physicalFamily, settings,
        checkpointDistance: 2600, requirements: { encountersCleared: 1 } });
    }
  }
  return { format: 'pulse-generated-duels-v1', seed, counts: { train, development, finalTest }, rivalPool: RIVAL_POOL, cases,
    finalTestRule: 'Freeze the selected model and evaluation rules before running final-test. Do not tune or train from final-test outcomes.',
    scope: 'Harbor Ring, clear weather, GTP. Same-class same-pace duels from reference-lap states: pass one of one or two GTP rivals within 90 s.' };
}
