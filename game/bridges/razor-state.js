import { apexState } from './apex-state.js';

// Uses only the public race envelope: flags, weather, pit calls and timing.
export function razorState(race, car) { return apexState(race, car); }
