// Real physics, deliberately staged encounters. Every attack has an otherwise
// identical traffic-aware attacks-disabled counterfactual. A faster finish or
// an ATTACK label alone never counts as proof of a tactical overtake.
import { pathToFileURL } from 'node:url';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { createSeatBridge } from '../../../game/core/field.js';
import { createRazorBridge } from '../../../game/bridges/razor-bridge.js';
import { razorState } from '../../../game/bridges/razor-state.js';
import { createApexBridge } from '../../../game/bridges/apex-bridge.js';

const round = (n, p = 3) => +n.toFixed(p);
const sampleAt = (line, a, s) => { const j = line.stationOf(s); return line.sample(a, Math.floor(j), j % 1); };
const wrap = (n, L) => ((n + 1.5 * L) % L) - L / 2;

export const CASES = [
  { name: 'straight-same-class', s: 250, gap: 14, cls: 'lmdh', rival: 'apex', margin: 0.95 },
  { name: 'corner-same-class', s: 760, gap: 11, cls: 'lmdh', rival: 'apex', margin: 0.95 },
  { name: 'close-corner-entry', s: 600, gap: 6, cls: 'lmdh', rival: 'apex', margin: 0.95 },
  { name: 'corner-exit', s: 1700, gap: 6, cls: 'lmdh', rival: 'apex', margin: 0.95 },
  { name: 'gtp-through-gt3', s: 300, gap: 23, cls: 'lmdh', rival: 'apex', rivalClass: 'gt' },
  { name: 'gt3-same-class', s: 270, gap: 12, cls: 'gt', rival: 'apex', margin: 0.95 },
  { name: 'stopped-car', s: 310, gap: 78, cls: 'lmdh', rival: 'stopped', yaw: 0 },
  { name: 'spun-car', s: 310, gap: 78, cls: 'lmdh', rival: 'stopped', yaw: Math.PI / 2 },
  { name: 'self-fight', s: 300, gap: 13, cls: 'lmdh', rival: 'razor' },
  { name: 'self-fight-matched', s: 300, gap: 13, cls: 'lmdh', rival: 'razor', matchRivalHz: true },
  { name: 'apex-near-pace', s: 300, gap: 10, cls: 'lmdh', rival: 'apex' }
];

export function runEncounter(setup, { attacks = true, hz = 60, duration = 24, trace = false } = {}) {
  const track = new Track('harbor-ring'), cls = setup.cls, leadClass = setup.rivalClass ?? cls;
  const ids = ['razor', setup.rival], classes = [cls, leadClass];
  const teams = ids.map((id, index) => ({ id: 't' + index, name: id, short: id, index, classId: classes[index], raceClass: classes[index] === 'lmdh' ? 'gtp' : 'gt3', color: '#fff', grid: index,
    drivers: [{ id, name: id, short: id, kind: 'ai' }] }));
  const costs = [], updatePeriod = 1 / hz;
  const makeBridge = (seat, index, race) => {
    if (index === 0 || setup.matchRivalHz) {
      const held = { t: -1, controls: null };
      const b = index === 0
        ? createRazorBridge({ hostTrack: track, index, options: { attacks, strategy: false, ...setup.driverOptions }, state: c => razorState(race, c) })
        : createSeatBridge(seat, index, race);
      return {
        get driver() { return b.driver; }, get errors() { return b.errors; }, get lastError() { return b.lastError; },
        reset(s) { b.reset(s); held.t = -1; held.controls = null; }, debug: () => b.debug(),
        update(c, all, dt, context) {
          if (context.time - held.t + 1e-6 >= updatePeriod) {
            const t = performance.now(); b.update(c, all, held.t < 0 ? updatePeriod : context.time - held.t, context);
            if (index === 0) costs.push(performance.now() - t);
            held.t = context.time; held.controls = { ...c.controls };
          } else c.controls = { ...held.controls };
        }
      };
    }
    if (seat.id === 'stopped') return { update(c) { c.controls = { throttle: 0, brake: 1, steer: 0 }; }, reset() {} };
    if (seat.id === 'apex' && setup.margin) return createApexBridge({ hostTrack: track, index, options: { margin: setup.margin } });
    return createSeatBridge(seat, index, race);
  };
  const race = new EnduranceRace({ track, teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: 30, makeBridge, startCompound: 'soft', caution: 'off' });
  race.start(); race.phase = 'racing'; race.countdown = 0;
  for (const e of race.entries) e.strategist.decide = () => null;
  const driver = race.entries[0].bridges[0].driver, line = driver.line;
  const start = setup.s, speed = Math.min(65, sampleAt(line, line.v, start) * 0.96);
  for (let i = 0; i < 2; i++) {
    const c = race.cars[i], s = start + (i ? setup.gap : 0), ownLine = race.entries[i].bridges[0].driver?.line ?? line;
    const lat = setup.lateral?.[i] ?? sampleAt(ownLine, ownLine.lat, s);
    const v = i && setup.rival === 'stopped' ? 0 : Math.min(speed, sampleAt(ownLine, ownLine.v, s) * 0.96);
    c.place(track, s, lat, v); race.fitTyres(c, 'soft', true); c.fuel = 35;
    for (const w of c.wheels) { w.tyre.core = w.tyre.optimum; w.tyre.surface = w.tyre.optimum; w.tyre.wear = 0.1; }
    const q = ownLine.closest(c.x, c.z), h = ownLine.heading(q.i, q.f);
    c.yaw = h + (i ? setup.yaw ?? 0 : 0); c.vx = Math.sin(c.yaw) * v; c.vz = Math.cos(c.yaw) * v; c.u = v; c.v = 0;
    c.yawRate = sampleAt(ownLine, ownLine.ks, s) * v;
    c.gear = race.entries[i].bridges[0].driver?.model?.gearAt(v) ?? Math.min(c.spec.gears.length - 1, driver.model.gearAt(v));
    c.race.previousS = c.s; c.race.progress = s - start; c.race.lapStart = 0;
    race.entries[i].bridges[0].reset?.({ cars: race.cars, track });
  }
  race.timingHistory = race.cars.map(c => [{ progress: c.race.progress, time: 0 }]);
  const contactLog = [], pairPush = race.collisionStats.pairs.push.bind(race.collisionStats.pairs);
  race.collisionStats.pairs.push = (...pairs) => {
    for (const pair of pairs) if (contactLog.length < 8 || pair[2] > 3) {
      const [c, r] = race.cars, d = race.entries[0].bridges[0].driver;
      contactLog.push({ t: round(race.time, 2), closing: round(pair[2], 2), s: round(c.s), lat: round(c.lateral), rivalS: round(r.s), rivalLat: round(r.lateral),
        v: round(c.speed), target: round(d.targetSpeed), throttle: round(c.controls.throttle), brake: round(c.controls.brake), side: d.combat.plan?.side, e: round(d.e), cap: Number.isFinite(d.combat.cap) ? round(d.combat.cap) : null });
    }
    return pairPush(...pairs);
  };
  let passedAt = null, firstClear = null, sideTime = 0, sideThrottle = 0, brakingSide = 0, maxSteerStep = 0, minSpeed = speed;
  let prevSteer = 0, off = 0, sideFlips = 0, side = 0, lastSide = 0, behindSeconds = 0;
  let attackSideFlips = 0, lastAttackSide = 0, lastAttackTarget = null;
  const rows = [], offLog = [], intentSeconds = {}, dt = FIXED_DT;
  while (race.time < duration) {
    race.step(dt);
    const [c, rival] = race.cars, d = race.entries[0].bridges[0].driver;
    const gap = rival.race.progress - c.race.progress;
    const alongside = Math.abs(gap) < c.spec.halfLength + rival.spec.halfLength + 0.5;
    if (alongside) { sideTime += dt; sideThrottle += c.controls.throttle * dt; brakingSide += c.controls.brake * dt; }
    if (gap < -6) { firstClear ??= race.time; if (race.time - firstClear > 1.5) passedAt ??= firstClear; } else firstClear = null;
    if (gap > 0 && gap < 40) behindSeconds += dt;
    maxSteerStep = Math.max(maxSteerStep, Math.abs(c.controls.steer - prevSteer)); prevSteer = c.controls.steer;
    if (Math.abs(c.lateral) > track.halfWidth + track.curbWidth) {
      off += dt;
      if (trace && offLog.length < 4) {
        const path = d.path, q = path.closest(c.x, c.z, d.cursor), x = path.sample(path.px, q.i, q.f), z = path.sample(path.pz, q.i, q.f);
        offLog.push({ t: race.time, s: c.s, lat: c.lateral, pathLat: track.nearest(x, z).lateral, e: q.e,
          v: c.speed, yaw: c.yaw, pathH: path.heading(q.i, q.f), steer: c.controls.steer, kind: d.combat.plan?.kind,
          controlE: d.e, indices: [d.cursor, d.cur.i, q.i], prediction: d.delay, age: d.controlDelay,
          nearE: path.closest(c.x, c.z, d.cur.i).e });
      }
    }
    minSpeed = Math.min(minSpeed, c.speed);
    side = d.combat.plan?.side ?? 0;
    if (side && lastSide && side !== lastSide) sideFlips++;
    if (side) lastSide = side;
    if (!passedAt && d.combat.plan?.kind === 'attack') {
      const target = d.combat.plan.target;
      if (target === lastAttackTarget && lastAttackSide && side !== lastAttackSide) attackSideFlips++;
      lastAttackSide = side; lastAttackTarget = target;
    } else if (d.combat.plan?.kind !== 'attack' && Math.abs(d.combat.me?.e ?? 0) < 0.25) {
      lastAttackSide = 0; lastAttackTarget = null;
    }
    intentSeconds[d.intent] = (intentSeconds[d.intent] ?? 0) + dt;
    if (trace && Math.round(race.time * 120) % 30 === 0) rows.push({ t: round(race.time, 2), s: round(c.s, 1), v: round(c.speed, 1), gap: round(gap, 1), lat: round(c.lateral, 2), rivalLat: round(rival.lateral, 2), throttle: round(c.controls.throttle, 2), brake: round(c.controls.brake, 2), steer: round(c.controls.steer, 3), target: round(d.targetSpeed, 1), state: d.intent, side, stab: round(d.stability, 2), cap: Number.isFinite(d.combat.cap) ? round(d.combat.cap, 1) : null, cands: d.combat.visCands.map(q => ({ side: q.side, kind: q.kind, score: q.score, risk: q.risk, chosen: q.chosen })) });
  }
  const c = race.cars[0], lead = race.cars[1], bridge = race.entries[0].bridges[0]; costs.sort((a, b) => a - b);
  const out = { case: setup.name, attacks, hz, matchedRivalHz: Boolean(setup.matchRivalHz), passedAt: passedAt && round(passedAt, 2), gain: round(c.race.progress - lead.race.progress, 1), behindSeconds: round(behindSeconds, 1),
    contacts: race.contacts, severe: race.collisionStats.severeContacts, peakClosing: round(race.collisionStats.peakClosing, 1), off: round(off), minSpeed: round(minSpeed, 1),
    sideSeconds: round(sideTime, 1), sideThrottle: sideTime ? round(sideThrottle / sideTime, 2) : null, sideBrake: sideTime ? round(brakingSide / sideTime, 2) : null,
    sideFlips, attackSideFlips, maxSteerStep: round(maxSteerStep), updateP95ms: round(costs[Math.floor(costs.length * 0.95)] ?? 0), errors: bridge.errors, lastError: bridge.lastError,
    damage: round(c.damage), contactLog: contactLog.slice(0, 10), intentSeconds: Object.fromEntries(Object.entries(intentSeconds).map(([k, v]) => [k, round(v, 1)])), stats: bridge.driver.combat.stats, events: bridge.driver.combat.events,
    ...(bridge.errors ? { fault: { debug: bridge.driver.debug(), field: bridge.driver.field.list.map(r => ({ id: r.id, width: r.width, v: r.v, lat: r.lat, ds: r.ds })) } } : {}) };
  if (trace) { out.trace = rows; out.offLog = offLog; }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.argv[2] ?? 'all', hz = Number(process.argv[3] ?? 60), trace = process.argv.includes('--trace');
  for (const setup of CASES.filter(s => name === 'all' || s.name === name)) {
    const enabled = runEncounter(setup, { attacks: true, hz, trace });
    const control = runEncounter(setup, { attacks: false, hz });
    console.log(JSON.stringify({ enabled, control,
      moveDemonstrated: enabled.passedAt !== null && (control.passedAt === null || enabled.passedAt + 1 < control.passedAt)
        && enabled.stats.associatedPasses > 0 && enabled.severe === 0 && enabled.off === 0 && enabled.errors === 0 }));
  }
}
