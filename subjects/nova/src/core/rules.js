// DeepSeek core rules shared by the plant and the AI.
// Half the car must stay on the asphalt for a lap to remain valid, matching the
// shared benchmark rule (session.js): |lateral| + halfCar <= halfWidth.

export const CAR_HALF_WIDTH = 0.99;
export const CAR_HALF_LENGTH = 2.3;

export function halfCarInside(lateral, halfWidth, halfCar = CAR_HALF_WIDTH) {
  return Math.abs(lateral) + halfCar <= halfWidth;
}

export function offTrack(lateral, halfWidth, halfCar = CAR_HALF_WIDTH) {
  return !halfCarInside(lateral, halfWidth, halfCar);
}
