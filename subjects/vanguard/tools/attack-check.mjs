import assert from 'node:assert/strict';
import { selectCandidate } from '../src/battle.js';

const clean = { fits: true, risk: 0, score: 105, exit: 52, finalGap: 8 };
const risky = { ...clean, risk: 2, score: 120 };
let chosen = selectCandidate(null, risky, 0.8);
chosen = selectCandidate(chosen, clean, 0.8);
assert.equal(chosen, clean, 'an unsafe high-score lane cannot mask an admissible passing lane');
assert.equal(selectCandidate(clean, risky, 0.8), clean, 'candidate order does not bypass the collision budget');
assert.equal(selectCandidate(null, { ...clean, fits: false }, 0.8), null, 'road width still constrains commitment');
assert.equal(selectCandidate(null, { ...clean, hardImpact: true }, 20), null, 'a permissive current-route risk cannot authorise a predicted heavy impact');

const better = { ...clean, score: 108 };
assert.equal(selectCandidate(clean, better, 0.8), better, 'admissible alternatives still compete on progress and exit speed');
assert.equal(selectCandidate(better, clean, 0.8), better, 'the safer ranking preserves the best admissible lane');
assert.equal(selectCandidate(null, { ...clean, risk: 0.8 }, 0.8), null, 'the original strict collision limit is preserved');
console.log('VANGUARD attack commitment checks passed.');
