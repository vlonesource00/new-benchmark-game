// SLIPSTREAM test seat inside the real game page (?debug): the exported actor drives one car through the browser seat
// protocol (one request in flight, controls held until the reply lands, replies taken between frames) and every
// timing the training env models is measured: reply wall time, command age, substeps per decision, delivered rate.
//   const { installTestSeat } = await import(<this module>); const t = await installTestSeat(__pe, { carIndex, exportUrl });
//   ... later: t.report()
import { observe, roadTable, OBS } from '../env/observe.mjs';

const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const summ = (xs, d = 2) => xs.length ? { n: xs.length, mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(d), p50: +q(xs, 0.5).toFixed(d), p90: +q(xs, 0.9).toFixed(d), p99: +q(xs, 0.99).toFixed(d), max: +Math.max(...xs).toFixed(d) } : null;

// minGap: least sim time between queries. Training decides on a 4-substep (1/30 s) grid, so the GRU's clock only matches
// when the seat is held to that rate; minGap 0 queries on every free substep (one per rendered frame).
export async function installTestSeat(pe, { carIndex, exportUrl, minGap = 4 / 120 }) {
  const race = pe.race, car = race.cars[carIndex], entry = race.entries[carIndex], track = race.track;
  const exp = await (await fetch(exportUrl)).json();
  const worker = new Worker(new URL('./seat-worker.mjs', import.meta.url), { type: 'module' });
  await new Promise((res) => { worker.onmessage = ({ data }) => data.type === 'ready' && res(); worker.postMessage({ type: 'init', exp }); });
  const road = roadTable(track), limit = track.halfWidth + (track.curbWidth ?? 0), o = new Float32Array(OBS);
  const iface = { applied: [0, 0], appliedAge: 0, sent: [0, 0], pending: 0 };
  const log = { replies: [], subs: 0, ageSum: 0, ages: [], frames: [], t0Sim: race.time, t0Wall: performance.now(), dts: [] };
  let lastPostSim = -1e9, inFlight = null, arrived = null, seq = 0, first = true, subsSincePost = 0, lastUpdateWall = 0, obsSimOfApplied = null;
  worker.onmessage = ({ data }) => { if (data.type === 'controls' && inFlight && data.seq === inFlight.seq) arrived = { ...data, wall: performance.now() }; };
  // Frame clock: rAF intervals while the seat runs (the physics bursts once per frame).
  let rafOn = true, lastRaf = null;
  const raf = (t) => { if (lastRaf != null) log.frames.push(t - lastRaf); lastRaf = t; if (rafOn) requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  const bridge = {
    slipstream: true, errors: 0,
    update(c, cars, dt, context) {
      const now = performance.now();
      if (arrived) {
        // Reply delivered: it is applied from this substep on (the game's async seat does the same).
        log.replies.push({ wallMs: arrived.wall - inFlight.wall, applyWallMs: now - inFlight.wall, computeMs: arrived.computeMs,
          simDelay: race.time - inFlight.sim, subs: subsSincePost + 1 }); // substeps from the observed one to the first driven by the reply (the env latency unit)
        iface.applied = [arrived.steer, arrived.pedal]; iface.appliedAge = 0; obsSimOfApplied = inFlight.sim;
        inFlight = null; arrived = null; iface.pending = 0;
      }
      const [st, pd] = iface.applied;
      c.controls = { steer: st, throttle: pd > 0 ? pd : 0, brake: pd < 0 ? -pd : 0 };
      if (entry.pit || entry.pitPlan) { entry.pit = null; entry.pitPlan = null; c.race.pitLap = false; }
      if (obsSimOfApplied != null) { const age = race.time - obsSimOfApplied; log.ageSum += age; log.ages.push(age); }
      log.subs++; subsSincePost++; log.driveSim = (log.driveSim ?? 0) + dt; log.dts.push(dt);
      if (!inFlight && race.time - lastPostSim >= minGap - 1e-6) {
        lastPostSim = race.time;
        observe(o, { car: c, road, track, limit, cars: race.cars, learnerIds: [c.id], iface });
        inFlight = { seq: ++seq, wall: now, sim: race.time };
        iface.sent = [st, pd]; iface.pending = 1; subsSincePost = 0;
        worker.postMessage({ type: 'step', seq, obs: o, first });
        first = false;
      }
      iface.appliedAge += dt;
      lastUpdateWall = now;
    },
    prime() {}, reset() { first = true; inFlight = null; arrived = null; iface.applied = [0, 0]; iface.pending = 0; },
    debug() { return { architecture: 'SLIPSTREAM test seat' }; }
  };
  entry.bridges[entry.active] = bridge;
  return {
    bridge, log,
    report() {
      const simS = race.time - log.t0Sim, wallS = (performance.now() - log.t0Wall) / 1000, R = log.replies;
      return { track: track.id ?? track.name, car: carIndex, minGapMs: +(minGap * 1000).toFixed(1), simS: +simS.toFixed(1), wallS: +wallS.toFixed(1), decisions: R.length,
        seatDrivenS: +(log.driveSim ?? 0).toFixed(1), decisionsPerSimS: +(R.length / Math.max(1e-9, log.driveSim ?? 0)).toFixed(2), substepMs: summ(log.dts.map((d) => d * 1000)), substeps: log.subs, substepsPerDecision: +(log.subs / Math.max(1, R.length)).toFixed(2),
        replyWallMs: summ(R.map((r) => r.wallMs)), replyToApplyWallMs: summ(R.map((r) => r.applyWallMs)), computeMs: summ(R.map((r) => r.computeMs), 3),
        commandDelaySimMs: summ(R.map((r) => r.simDelay * 1000)), commandDelaySubsteps: summ(R.map((r) => r.subs), 1),
        controlAgeSimMs: summ(log.ages.map((a) => a * 1000)), frameMs: summ(log.frames),
        speedKmh: +(car.speed * 3.6).toFixed(0), offtrack: +(car.race.offtrack ?? 0).toFixed(2), damage: +car.damage.toFixed(3), lap: car.race.lap };
    },
    stop() { rafOn = false; worker.terminate(); }
  };
}
