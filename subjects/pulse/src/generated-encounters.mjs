import { createHash } from 'node:crypto';
import { timingProfile } from '../tools/timing-profiles.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rng = seed => { let s = seed >>> 0; return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 2 ** 32; }; };
const round = (value, scale = 10) => Math.round(value * scale) / scale;
export function generateEncounters({ seed = 7229, train = 32, development = 12, finalTest = 12 } = {}) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff
    || ![train, development, finalTest].every(n => Number.isInteger(n) && n >= 8 && n <= 256))
    throw Error('Generated encounter counts must be 8–256 per split; seed must be uint32');
  const cases = [], families = new Set();
  const splitKeys = [['train', train, 0x5054524e], ['development', development, 0x50444556], ['final-test', finalTest, 0x50544553]];
  for (const [split, count, salt] of splitKeys) {
    const draw = rng(seed ^ salt), pick = list => list[Math.floor(draw() * list.length)];
    for (let i = 0; i < count; i++) {
      const fixture = ['train', 'train', 'train', 'train', 'solo', 'train', 'stopped', 'spun'][i % 8];
      const settings = { track: 'harbor-ring', classId: 'lmdh', fixture, weather: 'clear',
        seed: Math.floor(draw() * 0x7fffffff), start: round(20 + draw() * 130),
        lateral: round((draw() * 2 - 1) * .6, 100), yawOffset: round((draw() * 2 - 1) * .01, 10000),
        speed: round(40 + draw() * 9), rival: 'intercept', rivalGap: round(30 + draw() * 60),
        trainSpacing: round(60 + draw() * 45), rivalOffset: round((draw() * 2 - 1) * .8, 100),
        rivalSpeed: round(37 + draw() * 10),
        tailGapDelta: fixture === 'train' ? round((draw() * 2 - 1) * 25) : 0,
        tailSpeed: fixture === 'train' && draw() > .5 ? round(35 + draw() * 16) : null,
        hazardAt: 0, seconds: fixture === 'solo' ? 120 : fixture === 'train' && i % 2 ? 90 : 60 };
      // Identity ignores duration, physics seed and scheduling. Changing any of
      // those cannot make the same placed encounter an independent holdout.
      const { seed: _seed, seconds: _seconds, ...physical } = settings, physicalFamily = hash(physical);
      if (families.has(physicalFamily)) throw Error('Duplicate generated physical encounter');
      families.add(physicalFamily);
      const profile = pick(['frame-120', 'frame-60', 'frame-30', 'lag-1', 'lag-2', 'jitter']);
      Object.assign(settings, timingProfile(profile), { scheduleSeed: Math.floor(draw() * 0xffffffff) });
      cases.push({ id: `${split}-${String(i + 1).padStart(3, '0')}-${fixture}`, split, profile, physicalFamily, settings,
        checkpointDistance: settings.seconds >= 90 ? 4500 : 2700,
        requirements: fixture === 'train' ? { retainedPasses: 3 } : fixture === 'solo' ? { validFullLaps: 1 } : { hazardsCleared: 1 } });
    }
  }
  return { format: 'pulse-generated-encounters-v1', seed, counts: { train, development, finalTest }, cases,
    finalTestRule: 'Freeze the selected model and evaluation rules before running final-test. Do not tune or train from final-test outcomes.',
    scope: 'Harbor Ring, clear weather, GTP on soft tyres. Randomized straight arrivals, lateral starts, rival spacing/speed and tail timing; not all-track or full-race certification.' };
}
