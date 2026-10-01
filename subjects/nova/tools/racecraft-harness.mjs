// Deterministic racecraft test harness
// Evaluates multi-car interaction scenarios:
// 1. 2-car straight attack
// 2. 2-car braking-zone attack
// 3. 2-car defense
// 4. 4-car pack
// 5. 8-car pack

import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';

const DT = 1 / 120;

export function runScenario(scenarioName, durationSeconds = 15.0) {
  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt' });
  session.aiOptions = { lineVariant: 'measured' };

  if (scenarioName === 'straight-attack') {
    session.mode = 'race';
    session.field = 2;
    session.autopilot = true;
    session.start();

    // Place lead car at s=350m, speed=46 m/s (165 km/h)
    // Place trailing car at s=310m, speed=58 m/s (208 km/h) with closure
    const c0 = session.cars[0];
    const c1 = session.cars[1];
    c1.place(track, 350, 0.0);
    c1.speed = 46.0;
    c0.place(track, 310, 0.5);
    c0.speed = 58.0;
  } else if (scenarioName === 'braking-attack') {
    session.mode = 'race';
    session.field = 2;
    session.autopilot = true;
    session.start();

    // Place approaching first chicane: s=600m
    const c0 = session.cars[0];
    const c1 = session.cars[1];
    c1.place(track, 630, -0.5);
    c1.speed = 55.0;
    c0.place(track, 600, 1.2);
    c0.speed = 62.0;
  } else if (scenarioName === 'defense') {
    session.mode = 'race';
    session.field = 2;
    session.autopilot = true;
    session.start();

    // Car 0 is leader defending into East Hairpin s=1000m
    // Car 1 is closing fast from behind
    const c0 = session.cars[0];
    const c1 = session.cars[1];
    c0.place(track, 1050, 0.0);
    c0.speed = 42.0;
    c1.place(track, 1025, 1.0);
    c1.speed = 48.0;
  } else if (scenarioName === 'pack-3') {
    session.mode = 'race';
    session.field = 3;
    session.autopilot = true;
    session.start();
  } else if (scenarioName === 'pack-4') {
    session.mode = 'race';
    session.field = 4;
    session.autopilot = true;
    session.start();
  } else if (scenarioName === 'pack-8') {
    session.mode = 'race';
    session.field = 8;
    session.autopilot = true;
    session.start();
  }

  let totalFlankReversals = 0;
  let totalTargetQSignChanges = 0;
  let offtrackFrames = 0;
  const offtrackEvents = [];
  let spinFrames = 0;
  const initialContacts = session.contacts;
  const contactEvents = [];
  let previousContacts = session.contacts;

  let lastSides = new Map();
  let lastTargetQSigns = new Map();

  const totalSteps = Math.round(durationSeconds / DT);

  for (let step = 0; step < totalSteps; step++) {
    session.step(DT, { throttle: 0, brake: 0, steer: 0 });
    if (session.contacts > previousContacts && contactEvents.length < 12) {
      contactEvents.push({ t: +(step * DT).toFixed(2), cars: session.activeCars.map((c, i) => ({
        id: c.id, s: +c.s.toFixed(1), q: +c.lateral.toFixed(2), v: +c.speed.toFixed(1),
        topology: session.drivers[i]?.ai?.topologyResult?.activeTopology,
        cap: session.drivers[i]?.ai?.topologyResult?.targetSpeedCap,
      })) });
    }
    previousContacts = session.contacts;

    const active = session.activeCars;
    for (let i = 0; i < active.length; i++) {
      const car = active[i];
      const ai = session.drivers[i]?.ai;
      const q = car.lateral;
      const targetQ = ai?.topologyPlanner?.targetQ ?? ai?.state?.targetQ ?? 0;

      // Legality & spin check
      if (Math.abs(q) > 7.21) {
        offtrackFrames++;
        if (offtrackEvents.length < 15) offtrackEvents.push({ t: +(step * DT).toFixed(2), id: car.id, s: +car.s.toFixed(1),
          q: +q.toFixed(2), topology: ai?.topologyResult?.activeTopology, phase: ai?.topologyResult?.phase });
      }
      if (Math.abs(car.yawRate || 0) > 2.5) spinFrames++;

      // Sign changes in targetQ
      const sign = Math.sign(targetQ);
      const lastSign = lastTargetQSigns.get(car.id) || 0;
      if (sign !== 0 && lastSign !== 0 && sign !== lastSign) {
        totalTargetQSignChanges++;
      }
      if (sign !== 0) lastTargetQSigns.set(car.id, sign);

      // Flank reversals relative to nearby rival
      if (i > 0) {
        const lead = active[i - 1];
        const flank = Math.sign(car.lateral - lead.lateral);
        const lastFlank = lastSides.get(car.id) || 0;
        if (flank !== 0 && lastFlank !== 0 && flank !== lastFlank && Math.abs(car.s - lead.s) < 25) {
          totalFlankReversals++;
        }
        if (flank !== 0) lastSides.set(car.id, flank);
      }
    }
  }

  const contacts = session.contacts - initialContacts;
  return {
    scenario: scenarioName,
    duration: durationSeconds,
    cars: session.activeCars.length,
    flankReversals: totalFlankReversals,
    targetQSignChanges: totalTargetQSignChanges,
    offtrackFrames,
    offtrackEvents,
    spinFrames,
    contacts,
    contactEvents,
    carResults: session.activeCars.map(c => ({
      id: c.id, lastLap: c.race.lastLap, bestLap: c.race.bestLap,
      offtrackSeconds: c.race.offtrack, damage: c.damage,
    })),
  };
}

if (process.argv[1]?.endsWith('racecraft-harness.mjs')) {
  console.log('======================================================================');
  console.log('                 NOVA RACECRAFT HARNESS BENCHMARK                      ');
  console.log('======================================================================\n');

  const scenarios = ['straight-attack', 'braking-attack', 'defense', 'pack-3', 'pack-4', 'pack-8'];
  const results = [];

  for (const sc of scenarios) {
    const dur = sc.startsWith('pack') ? 25.0 : 10.0;
    const res = runScenario(sc, dur);
    results.push(res);
    console.log(`[${res.scenario}] Cars: ${res.cars} | Flank Reversals: ${res.flankReversals} | targetQ Inversions: ${res.targetQSignChanges} | Offtracks: ${res.offtrackFrames} | Spins: ${res.spinFrames} | Contacts: ${res.contacts}`);
  }
}
