// Observation contract tests: every block holds exactly what its declared boundaries say.
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/contract-tests.mjs
import { World, OBS, EGO_F, ROAD_K, ROAD_F, RIVAL_N, RIVAL_F } from './world.mjs';

const mk = (seed) => { let s = seed; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });
const SENT = 12345.5, R0 = EGO_F + ROAD_K * ROAD_F;

// Two learners started side by side near the same place, so each is the other's nearest rival.
const w = new World({ track: 'harbor-ring', learners: 2, ai: [], seed: 5, lifetime: 900, latency: { min: 1, max: 1 },
  episode: { min: 60, max: 120 }, starts: { snapshot: 0, standing: 1, at: 600, spread: 12 } }, mk(3));
const [a, b] = w.agents;
const o = new Float32Array(OBS + 8).fill(SENT);
w.observe(a, o);

// 1. The writer fills exactly OBS values: nothing past the end, nothing left unwritten.
const unwritten = [...o.subarray(0, OBS)].filter((x) => x === SENT).length;
check('length', unwritten === 0 && o.subarray(OBS).every((x) => x === SENT), `OBS=${OBS} unwritten=${unwritten} spill=${o.subarray(OBS).filter((x) => x !== SENT).length}`);

// 2. Ego block ends with the hybrid charge (GT car: 0) and the declared sizes add up.
check('sizes', OBS === EGO_F + ROAD_K * ROAD_F + RIVAL_N * RIVAL_F, `${EGO_F}+${ROAD_K * ROAD_F}+${RIVAL_N * RIVAL_F}=${OBS}`);

// 3. Road block: sample 0 is ahead of the car (forward > 0), cos(relative heading) near 1 on a start straight.
const fwd0 = o[EGO_F] * 100, cos0 = o[EGO_F + 3];
check('road-block', fwd0 > 0 && fwd0 < 30 && cos0 > 0.5, `fwd0=${fwd0.toFixed(2)} m cos0=${cos0.toFixed(3)}`);

// 4. Rival block: token 0 is the other learner: present, gap matches the track distance, flagged as a learner.
const L = w.track.length, g = (((b.car.s - a.car.s) / L + 1.5) % 1 - 0.5) * L;
const tok = o.subarray(R0, R0 + RIVAL_F);
check('rival-token', tok[0] === 1 && Math.abs(tok[7] * 100 - g) < 1 && tok[12] === 1 && tok[11] === 0,
  `present=${tok[0]} gap=${(tok[7] * 100).toFixed(1)} vs ${g.toFixed(1)} learner=${tok[12]} ghost=${tok[11]}`);
// 5. Unused rival slots are fully zero (no value from a neighbouring slot).
check('empty-slots', [...o.subarray(R0 + RIVAL_F, OBS)].every((x) => x === 0), 'slots 1..7');

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
