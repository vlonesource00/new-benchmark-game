// Three spatial lateral knots and an absolute speed; never wheel/pedal demand.
// Old two-value intention artifacts remain archived under their v1 contract.
export const PLAN_CONTRACT = Object.freeze({ version: 'pulse-route-speed-v3', coordinate: 'executable-course-arc-metres', width: 4,
  offsetMetres: 6, distances: Object.freeze([30, 70, 120]), speedCeiling: 95, speedSpan: 70,
  minimumSpeed: 25, rejoinMetres: 240, steerJerk: 180 });

export function decodePlan(action) {
  if (action?.length !== PLAN_CONTRACT.width || !Array.from(action).every(Number.isFinite))
    throw Error('Invalid lane/pace intention');
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  return { offsets: Array.from(action).slice(0, 3).map(x => clamp(x, -1, 1) * PLAN_CONTRACT.offsetMetres),
    speed: PLAN_CONTRACT.speedCeiling + clamp(action[3], -1, 0) * PLAN_CONTRACT.speedSpan };
}
