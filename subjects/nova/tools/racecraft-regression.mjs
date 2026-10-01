// Deterministic 120 Hz comparisons of NOVA's free-air and traffic behavior.
import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';

const dt = 1 / 120;
const duration = Number(process.argv[3] ?? 18);
const scenario = process.argv[2] ?? 'solo';
const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt' });
session.mode = 'race';
session.field = scenario.startsWith('solo') ? 1 : 3;
session.autopilot = true;
session.aiOptions = { lineVariant: 'measured' };
session.start();
session.phase = 'racing';
session.countdown = 0;

const [ego, lead, other] = session.cars;
const ref = session.drivers[0].ai.coupledController;
const startS = scenario.includes('chicane') ? 2310 : 400;
const ref0 = ref.sample(startS);
ego.place(track, startS, ref0.q, ref0.v);
ego.yaw = ref0.heading;
if (session.field > 1) {
  const gap = scenario === 'far' ? 850 : scenario === 'follow' ? 25 : 22;
  const leadS = startS + gap;
  const leadRef = ref.sample(leadS);
  lead.place(track, leadS, leadRef.q, scenario === 'far' ? leadRef.v : Math.max(20, ref0.v - (scenario === 'follow' ? 3 : 9)));
  lead.yaw = leadRef.heading;
  const otherS = startS + 1250;
  const otherRef = ref.sample(otherS);
  other.place(track, otherS, otherRef.q, otherRef.v);
  other.yaw = otherRef.heading;
}

let offtrackFrames = 0, spinFrames = 0, trafficCapFrames = 0, trafficBrakeFrames = 0;
let minSpeed = Infinity, maxSpeed = 0, brakeOnset = null, exitSpeed = 0, steerReversals = 0;
let lastSteer = 0, minGap = Infinity, maxLateralDifference = 0;
const samples = [];
const offtrackEvents = [];
let initialPlan = null;
const complex = scenario.includes('chicane') ? {
  distanceMeters: 300, progressMeters: 0, entrySpeed: ego.speed,
  minSpeed: Infinity, exitSpeed: null, sectorTime: null,
  brakeOnset: null, brakeFrames: 0, throttleCutFrames: 0,
  steerReversals: 0, meanAbsLineError: 0, maxAbsLineError: 0,
} : null;
let previousS = ego.s;
let complexLastSteer = 0, complexSamples = 0;
const steps = Math.round(duration / dt);
for (let i = 0; i < steps; i++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const ai = session.drivers[0].ai;
  const topo = ai.topologyResult;
  const st = ai.state;
  if (complex && complex.sectorTime === null) {
    const pathError = Math.abs(ego.lateral - ref.sample(ego.s).q);
    complex.meanAbsLineError += pathError;
    complex.maxAbsLineError = Math.max(complex.maxAbsLineError, pathError);
    complexSamples++;
    complex.minSpeed = Math.min(complex.minSpeed, ego.speed);
    if (ego.controls.brake > 0.05) {
      complex.brakeFrames++;
      if (complex.brakeOnset === null) complex.brakeOnset = i * dt;
    }
    if (ego.controls.throttle < 0.1 && ego.controls.brake < 0.02) complex.throttleCutFrames++;
    const complexSteer = Math.sign(ego.controls.steer);
    if (complexSteer && complexLastSteer && complexSteer !== complexLastSteer) complex.steerReversals++;
    if (complexSteer) complexLastSteer = complexSteer;
    const deltaS = ((ego.s - previousS + track.length * 1.5) % track.length) - track.length * 0.5;
    if (Math.abs(deltaS) < 20) complex.progressMeters += Math.max(0, deltaS);
    if (complex.progressMeters >= complex.distanceMeters) {
      complex.exitSpeed = ego.speed;
      complex.sectorTime = (i + 1) * dt;
      complex.meanAbsLineError /= complexSamples;
    }
  }
  previousS = ego.s;
  if (Math.abs(ego.lateral) > track.halfWidth - 1.01) {
    offtrackFrames++;
    if (offtrackEvents.length < 8) offtrackEvents.push({ t: +(i * dt).toFixed(2), s: +ego.s.toFixed(1), q: +ego.lateral.toFixed(2),
      leadQ: lead ? +lead.lateral.toFixed(2) : null, gap: lead ? +(lead.s - ego.s).toFixed(2) : null,
      topology: session.drivers[0].ai.topologyResult?.activeTopology,
      target: session.drivers[0].ai.topologyResult?.targetQ,
      ref: ref.sample(ego.s + 20).q });
  }
  if (Math.abs(ego.yawRate) > 2.5) spinFrames++;
  if (Number.isFinite(topo?.targetSpeedCap)) {
    trafficCapFrames++;
    if (ego.controls.brake > 0.02) trafficBrakeFrames++;
  }
  if (ego.controls.brake > 0.05 && brakeOnset === null) brakeOnset = i * dt;
  const steer = Math.sign(ego.controls.steer);
  if (steer && lastSteer && steer !== lastSteer) steerReversals++;
  if (steer) lastSteer = steer;
  minSpeed = Math.min(minSpeed, ego.speed);
  maxSpeed = Math.max(maxSpeed, ego.speed);
  exitSpeed = ego.speed;
  if (session.field > 1) minGap = Math.min(minGap, ((lead.s - ego.s + track.length * 1.5) % track.length) - track.length * 0.5);
  maxLateralDifference = Math.max(maxLateralDifference, Math.abs((topo?.targetQAt?.(ego.s + 20) ?? st.refQ) - ref.sample(ego.s + 20).q));
  if (i === 0) initialPlan = { selected: topo?.activeTopology, phase: topo?.phase, targetQ: topo?.targetQ, cap: topo?.targetSpeedCap, candidateCosts: topo?.candidates.map(c => ({ topology: c.topology, cost: +c.cost.toFixed(2), q: c.trajectory.map(p => +p.q.toFixed(2)) })) };
  if (i % 120 === 0) samples.push({ t: +(i * dt).toFixed(1), s: +ego.s.toFixed(1), q: +ego.lateral.toFixed(2), v: +ego.speed.toFixed(2),
    leadGap: session.field > 1 ? +(lead.s - ego.s).toFixed(2) : null,
    leadQ: session.field > 1 ? +lead.lateral.toFixed(2) : null,
    leadSpeed: session.field > 1 ? +lead.speed.toFixed(2) : null,
    throttle: +ego.controls.throttle.toFixed(2), brake: +ego.controls.brake.toFixed(2),
    cap: Number.isFinite(topo?.targetSpeedCap) ? +topo.targetSpeedCap.toFixed(2) : null, topology: topo?.activeTopology });
}
console.log(JSON.stringify({ scenario, duration, lap: ego.race.lastLap, bestLap: ego.race.bestLap, offtrackFrames, offtrackEvents, spinFrames, contacts: session.contacts, trafficCapFrames, trafficBrakeFrames, minSpeed, maxSpeed, brakeOnset, exitSpeed, steerReversals, minGap, maxLateralDifference, complex, initialPlan, samples }));
