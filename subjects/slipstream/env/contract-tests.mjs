// Observation contract tests: every block holds exactly what its declared boundaries say.
//   node --import ./scripts/json-loader.mjs subjects/slipstream/env/contract-tests.mjs
import { World, OBS, EGO_F, ROAD_K, ROAD_F, RIVAL_N, RIVAL_F, EGO_X, RIVAL_X, CORR_X } from './world.mjs';

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
const V2 = EGO_F + ROAD_K * ROAD_F + RIVAL_N * RIVAL_F;
const V3 = V2 + EGO_X + RIVAL_N * RIVAL_X;
check('sizes', OBS === V3 + CORR_X, `${EGO_F}+${ROAD_K * ROAD_F}+${RIVAL_N * RIVAL_F}+${EGO_X}+${RIVAL_N * RIVAL_X}+${CORR_X}=${OBS}`);

// 3. Road block: sample 0 is ahead of the car (forward > 0), cos(relative heading) near 1 on a start straight.
const fwd0 = o[EGO_F] * 100, cos0 = o[EGO_F + 3];
check('road-block', fwd0 > 0 && fwd0 < 30 && cos0 > 0.5, `fwd0=${fwd0.toFixed(2)} m cos0=${cos0.toFixed(3)}`);

// 4. Rival block: token 0 is the other learner: present, gap matches the track distance, flagged as a learner.
const L = w.track.length, g = (((b.car.s - a.car.s) / L + 1.5) % 1 - 0.5) * L;
const tok = o.subarray(R0, R0 + RIVAL_F);
check('rival-token', tok[0] === 1 && Math.abs(tok[7] * 100 - g) < 1 && tok[12] === 1 && tok[11] === 0,
  `present=${tok[0]} gap=${(tok[7] * 100).toFixed(1)} vs ${g.toFixed(1)} learner=${tok[12]} ghost=${tok[11]}`);
// 5. Unused rival slots are fully zero (no value from a neighbouring slot).
check('empty-slots', [...o.subarray(R0 + RIVAL_F, V2)].every((x) => x === 0) && [...o.subarray(V2 + EGO_X + RIVAL_X, V3)].every((x) => x === 0), 'slots 1..7 (v2 tokens and v3 context)');
// 6. v3 race context: own tier (GT = 0); slot 0 (the other GT learner): same class, no tier, lap or size difference.
const cx = o.subarray(V2 + EGO_X, V2 + EGO_X + RIVAL_X);
check('race-context', o[V2] === 0 && cx[0] === 1 && cx[1] === 0 && cx[2] === 0 && cx[3] === 0, `tier=${o[V2]} slot0=[${[...cx].join(',')}]`);

// 7. v4 corridor, with the other learner placed: 15 m ahead in line (body clearance = 15 - both half lengths, closing
// speed = our speed excess), 2 m ahead and 3 m to the right (alongside right), 3 m to the left (left), 15 m ahead but
// 4 m across (out of the corridor: nothing), and 15 m behind (nothing).
const corr = () => { const q = new Float32Array(OBS); w.observe(a, q); return [...q.subarray(V3, OBS)].map((x) => +x.toFixed(3)); };
const s0 = a.car.s, l0 = a.car.lateral;
const at = (ds, dl, vb, va = 20) => { a.car.place(w.track, s0, l0, va); b.car.place(w.track, s0 + ds, l0 + dl, vb); return corr(); };
const inLine = at(15, 0, 15), right = at(2, 3, 20), left = at(-1, -3, 20), wide = at(15, 4, 20), behind = at(-15, 0, 20);
const near = (x, y, e) => Math.abs(x - y) < e;
check('corridor-ahead', inLine[0] === 1 && near(inLine[1] * 30, 15 - 4.6, 0.6) && near(inLine[2] * 10, 5, 0.6) && inLine[7] === 0 && inLine[10] === 0, `[${inLine}]`);
check('corridor-sides', right[10] === 1 && right[7] === 0 && near(right[12] * 5, 2, 0.6) && left[7] === 1 && left[10] === 0 && right[0] === 0 && left[0] === 0, `right=[${right}] left=[${left}]`);
check('corridor-empty', wide[0] === 0 && wide[7] === 0 && wide[10] === 0 && behind[0] === 0 && behind[7] === 0 && behind[10] === 0, `wide=[${wide}] behind=[${behind}]`);

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
