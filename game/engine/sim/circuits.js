/**
 * Game fork circuits beyond Harbor Ring. Same scenario shape as
 * harbor-ring.js; every layout is flat (physics has no elevation) and was
 * checked with scripts/track-metrics.mjs for corner radius and clearance.
 */
import { NURBURGRING_POINTS, NURBURGRING_CORNERS } from './nurburgring.js';
// Long straights are split so Catmull-Rom segments stay short and even.
const pts = (list, split = true) => {
  const out = [];
  list.forEach(([x, z], i) => {
    const [nx, nz] = list[(i + 1) % list.length], n = split ? Math.ceil(Math.hypot(nx - x, nz - z) / 220) : 1;
    for (let k = 0; k < n; k++) out.push(Object.freeze({ x: x + (nx - x) * k / n, y: 0, z: z + (nz - z) * k / n }));
  });
  return Object.freeze(out);
};
const bands = (k) => Object.freeze([
  { type: 'fence', count: 150, lateralMin: 16, lateralMax: 22, scaleMin: 0.9, scaleMax: 1.1 },
  { type: 'tireStack', count: 48, lateralMin: 14, lateralMax: 19, scaleMin: 0.9, scaleMax: 1.2 },
  { type: 'marshal', count: Math.round(18 * k), lateralMin: 18, lateralMax: 25, scaleMin: 0.85, scaleMax: 1.1 },
  { type: 'crowd', count: Math.round(42 * k), lateralMin: 28, lateralMax: 39, scaleMin: 0.8, scaleMax: 1.25 }
]);
const circuit = (o) => Object.freeze({
  elevation: Object.freeze({ baseM: 0, minM: 0, maxM: 0, authoredDeltaM: 0, profile: 'flat' }),
  bankHints: Object.freeze([]),
  ...o,
  start: Object.freeze({ direction: 1, rows: 20, rowSpacingM: 8.8, laneOffsetM: 2.8, ...o.start }),
  pit: Object.freeze({
    side: 'right', lateralM: -13.8, entryLateralM: -10.8, exitLateralM: -9.0,
    pitSpeedLimitMps: 16.67, entrySpeedLimitMps: 23.5, boxSpeedMps: 1.1, stoppedSpeedMps: 0.55, serviceDurationS: 7.5, ...o.pit
  }),
  scenery: Object.freeze({ seed: o.seed, bands: bands(1), expectedInstanceCount: 0, drawCallBudget: 32 })
});

export const SOLENNE = circuit({
  id: 'solenne', name: 'Circuit Solenne', seed: 51007,
  description: 'The original rolling road course: a long pit straight, a quick left-right and a tight infield loop.',
  controlPoints: pts([
    [-380, -255], [0, -255], [325, -255], [460, -180], [475, -20], [370, 85], [245, 65], [195, -35],
    [95, -40], [40, 95], [140, 215], [30, 320], [-180, 300], [-360, 235], [-460, 100], [-435, -70]
  ], false),
  roadHalfWidth: 7.4, curbWidth: 1.1, runoffWidth: 11, sampleDensity: 34,
  sectors: Object.freeze([]), landmarks: Object.freeze([]),
  start: { finishFraction: 0.0676, gridFraction: 0.0507 },
  pit: { entryFraction: 0.9983, limiterFraction: 0.0135, boxStartFraction: 0.0811, boxEndFraction: 0.1487, exitFraction: 0.1892 }
});

export const ALPENRING = circuit({
  id: 'alpine', name: 'Alpenring Nacht', seed: 88213,
  description: 'Floodlit mountain circuit: a short pit straight, then fourteen corners between the pines.',
  controlPoints: pts([
    [-300, -300], [300, -300], [380, -270], [410, -200], [360, -120], [400, -40], [500, 0], [540, 90],
    [480, 170], [380, 160], [300, 90], [220, 120], [200, 220], [120, 300], [0, 290], [-80, 210],
    [-180, 230], [-280, 300], [-380, 260], [-420, 160], [-340, 80], [-420, -10], [-460, -150], [-400, -270]
  ]),
  roadHalfWidth: 7.6, curbWidth: 1.1, runoffWidth: 11, sampleDensity: 34,
  sectors: Object.freeze([]), landmarks: Object.freeze([]),
  start: { finishFraction: 0.0548, gridFraction: 0.0419 },
  pit: { entryFraction: 0.9871, limiterFraction: 0.0113, boxStartFraction: 0.0645, boxEndFraction: 0.1192, exitFraction: 0.1515 }
});

export const MIRAGE = circuit({
  id: 'desert', name: 'Mirage 1000', seed: 40433,
  description: 'Desert speedway road course: two very long straights and a huge sweeping final turn.',
  controlPoints: pts([
    [-700, -300], [500, -300], [620, -260], [660, -150], [600, -40], [650, 150], [620, 280], [480, 330],
    [-200, 330], [-300, 300], [-320, 200], [-200, 100], [-450, -40], [-700, -50], [-800, -150], [-790, -260]
  ]),
  roadHalfWidth: 8.4, curbWidth: 1.25, runoffWidth: 14, sampleDensity: 34,
  sectors: Object.freeze([]), landmarks: Object.freeze([]),
  start: { finishFraction: 0.0498, gridFraction: 0.0398 },
  pit: { entryFraction: 0.9925, limiterFraction: 0.01, boxStartFraction: 0.0597, boxEndFraction: 0.1095, exitFraction: 0.1493 }
});

// The 25.3 km 24h layout: GP-Strecke (no Mercedes-Arena) into the Nordschleife.
// Points are already ~10 m apart, so they are not split further. The pit lane
// runs on the left of the GP straight, entered after Hohenrain as in the race;
// it sits a little closer to the track so the garages stay inside the barrier.
export const NURBURGRING = circuit({
  id: 'nurburgring', name: 'Nürburgring 24h', seed: 24624,
  description: 'The 24 hours layout: the GP-Strecke and the full Nordschleife, 25.3 km through the Eifel forest.',
  controlPoints: pts(NURBURGRING_POINTS, false),
  roadHalfWidth: 6, curbWidth: 1, runoffWidth: 11.5, sampleDensity: 3,
  sectors: Object.freeze([]), landmarks: Object.freeze(NURBURGRING_CORNERS),
  start: { finishFraction: 0.01186, gridFraction: 0.01126 },
  pit: { lateralM: -12.8, entryFraction: 0.99565, limiterFraction: 0.99842, boxStartFraction: 0.00474, boxEndFraction: 0.01423, exitFraction: 0.02371 }
});

export const CIRCUITS = Object.freeze({ solenne: SOLENNE, alpine: ALPENRING, desert: MIRAGE, nurburgring: NURBURGRING });
