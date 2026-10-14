// SLIPSTREAM environment: the real game race loop (game/core/race.js EnduranceRace),
// unmodified. Learner seats are plain seat bridges whose controls come from an
// action buffer; every other seat is the game's own driver bridge.
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';

export { FIXED_DT };
const LIVERY = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000', '#aaffc3'];

// The race applies the tyre-saving pace governor to any driver id not flagged
// `governor: false` in the roster (core/teams.js). Learner seats carry a flagged
// id so the race treats them as flat-out AIs; the bridge itself is ours.
const LEARNER_ROSTER_ID = 'intercept';

/** Learner bridge: controls = action buffer row (steer, pedal); pedal > 0 throttle, < 0 brake. */
function learnerBridge(actions, slot) {
  return {
    slot,
    update(c) {
      const steer = actions[slot * 2], pedal = actions[slot * 2 + 1];
      c.controls = { steer, throttle: pedal > 0 ? pedal : 0, brake: pedal < 0 ? -pedal : 0 };
    },
    reset() {},
  };
}

/**
 * seats: [{ learner: true } | { ai: 'intercept' | 'apex' | 'razor' | 'next-racer' | ... }]
 * Returns { race, cars, learners (car indices), actions (Float32Array 2/learner), step(substeps) }.
 */
export function createRaceEnv({ track = 'harbor-ring', seats, seed = 7, weather = 'clear', laps = 30, classId = 'gt', startType = 'standing', format = null }) {
  const trk = typeof track === 'string' ? new Track(track) : track;
  const learners = []; seats.forEach((s, i) => s.learner && learners.push(i));
  const actions = new Float32Array(Math.max(1, learners.length) * 2);
  const teams = seats.map((s, i) => {
    const id = s.learner ? LEARNER_ROSTER_ID : s.ai;
    return { id: `t${i}`, name: s.learner ? `SLIP${i}` : id.toUpperCase(), short: s.learner ? `SL${i}` : id.slice(0, 3).toUpperCase(),
      color: LIVERY[i % LIVERY.length], index: i, starter: 0, grid: i,
      drivers: [{ kind: 'ai', id, name: id, short: id.slice(0, 3), learner: Boolean(s.learner) }] };
  });
  const makeBridge = (driver, index, race) => driver.learner ? learnerBridge(actions, learners.indexOf(index)) : createSeatBridge(driver, index, race);
  const race = new EnduranceRace({ track: trk, teams, format: format ?? { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false },
    laps, classId, makeBridge, seed, weather, startType });
  race.start();
  return {
    race, track: trk, cars: race.cars, learners, actions,
    step(substeps = 4) { for (let k = 0; k < substeps; k++) race.step(FIXED_DT); },
  };
}
