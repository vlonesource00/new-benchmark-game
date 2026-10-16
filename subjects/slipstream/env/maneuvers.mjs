// Overtaking maneuver detector: every race pass of a scored seat, classified by how it was made, plus attempts
// (getting alongside a car ahead) and how many of each kind were completed. A pass is an order change in race progress
// (same lap, neither car in its pit cycle) that holds HOLD s, as in env/scorecard.mjs. Kinds, from the cars' recorded
// positions, speeds, brake and wake over the LOOK s before the swap:
//   slipstream  on a straight: at least WAKE s in the rival's wake before pulling out, past before any braking zone
//   dive        into a corner on the inside, braking no earlier than the rival, alongside by the apex (lateBrakeM:
//               how much further down the road we braked)
//   outside     around the outside: alongside on the outside through the apex, completed on the exit
//   switchback  the rival took the inside on entry, we were behind at the apex, crossed under it and passed on exit
//   forced      the rival went off or slid while we had been within PRESS_GAP s of it for PRESS s
//   pace        none of these: a drag pass with no tow, an inside pass on corner speed (braked earlier), a better
//               exit on the same line, a rival error with no pressure, or a rival slowed by damage (reason says which)
// Corners are where the learner's line has smoothed curvature over K_CORNER (radius under ~220 m: a braking corner);
// the inside is the side with sign(curvature) * lateral > 0.
//   const mv = maneuvers(race, slots, track); ... after each env.step: mv.update(); ... mv.result(slot)
import { roadTable } from './observe.mjs';

const CAR_W = 2.0, CAR_L = 4.7, HZ = 20, KEEP = 14, SLIDE = 0.36; // SLIDE: a slip angle of ~20 deg, past any cornering slide
export const KINDS = ['slipstream', 'dive', 'outside', 'switchback', 'forced', 'pace'];
export const MANEUVERS = KINDS.filter((k) => k !== 'pace');

export function maneuvers(race, slots, track, { hold = 3, look = 3, kCorner = 1 / 220, wake = 0.8, press = 1.0, pressGap = 0.5, road = roadTable(track) } = {}) {
  const cars = race.cars, L = track.length, n = cars.length;
  const pitAt = new Array(n).fill(-1e9);
  // Shared sample clock at HZ: one row per car per sample, so pairs line up by index.
  const H = { t: [], c: cars.map(() => []) };
  const kAt = (s) => road.k[Math.floor(((s % L) + L) % L) % road.n];
  const seats = slots.map((slot) => ({ slot, me: cars[slot], st: cars.map((c) => ({ ahead: cars[slot].race.progress > c.race.progress, since: 0, pend: false, att: null, back: 0 })),
    passes: [], lost: [], attempts: [] }));
  let lastSample = -1e9;
  // Contact seconds per pair (cumulative), from the pairs the stewards consume each physics tick.
  const touch = new Float64Array(n * n), st0 = race.stewards;
  if (st0) { const step = st0.step.bind(st0); st0.step = (dt) => { for (const [i, j] of st0.pairs) { touch[i * n + j] += 1 / 120; touch[j * n + i] += 1 / 120; } return step(dt); }; }

  function sample(t) {
    H.t.push(t);
    cars.forEach((c, j) => H.c[j].push({ s: c.s, p: c.race.progress, lat: c.lateral, v: c.speed, vy: Math.abs(c.v ?? 0), br: c.controls?.brake ?? 0,
      wk: c.aero?.wake ?? 0, off: c.race.offtrack ?? 0, dmg: c.damage ?? 0, tc: touch.slice(j * n, j * n + n) }));
    if (H.t.length > KEEP * HZ * 1.5) { const cut = H.t.length - KEEP * HZ; H.t.splice(0, cut); H.c.forEach((a) => a.splice(0, cut)); }
  }
  const at = (t) => { let i = H.t.length - 1; while (i > 0 && H.t[i] > t) i--; return i; };

  // Classify the move against rival j that ended (swap, or the best point of a failed attempt) at time tEnd.
  function classify(slot, j, tEnd) {
    const me = H.c[slot], rv = H.c[j], e = at(tEnd), b = at(tEnd - 8); // side-by-side battles can run for seconds
    const dp = (i) => rv[i].p - me[i].p; // > 0: the rival is ahead
    // Overlap start: the last sample with the rival more than a car length ahead.
    let i0 = b; for (let i = e; i >= b; i--) if (dp(i) >= CAR_L) { i0 = Math.min(e, i + 1); break; }
    const pre = at(H.t[i0] - look);
    let pressS = 0, wakeS = 0;
    for (let i = pre; i <= i0; i++) {
      const g = dp(i) / Math.max(me[i].v, 10);
      if (g > 0 && g < pressGap) pressS += 1 / HZ;
      if (me[i].wk > 0.1) wakeS += 1 / HZ;
    }
    // A rival error inside the move: a real excursion (over 0.25 s off, not a kerb clip), or a slide past SLIDE at speed.
    // contactS: contact between the two cars from a second before the overlap to the swap (a push, not pressure, if large).
    const lo = at(H.t[i0] - 1), rvOff = rv[e].off - rv[lo].off;
    const base = { pressS: +pressS.toFixed(2), wakeS: +wakeS.toFixed(2), dur: +(H.t[e] - H.t[i0]).toFixed(2), rivalDmg: +rv[e].dmg.toFixed(3),
      contactS: +(me[e].tc[j] - me[lo].tc[j]).toFixed(2) };
    let rvSlip = 0; for (let i = lo; i <= e; i++) if (rv[i].v > 15) rvSlip = Math.max(rvSlip, rv[i].vy / rv[i].v);
    base.rvOff = +rvOff.toFixed(2); base.rvSlip = +rvSlip.toFixed(3);
    const err = rvOff > 0.25 || rvSlip > SLIDE;
    if (err) return { kind: pressS >= press ? 'forced' : 'pace', reason: 'rival-error', ...base };
    if (rv[e].dmg >= 0.3 && rv[e].dmg > me[e].dmg + 0.15) return { kind: 'pace', reason: 'rival-damaged', ...base };
    // The corner on our line from the overlap start to just past the swap.
    let kMax = 0, iA = -1;
    for (let i = i0; i <= e; i++) { const k = kAt(me[i].s); if (Math.abs(k) > Math.abs(kMax)) { kMax = k; iA = i; } }
    for (let d = 0; d <= 20; d += 4) { const k = kAt(me[e].s + d); if (Math.abs(k) > Math.abs(kMax)) { kMax = k; iA = e; } }
    if (Math.abs(kMax) < kCorner) {
      let braked = false; for (let i = i0; i <= e; i++) if (me[i].br > 0.3) braked = true;
      return wakeS >= wake && !braked ? { kind: 'slipstream', ...base } : { kind: 'pace', reason: wakeS >= wake ? 'late-tow' : 'drag', ...base };
    }
    const sg = Math.sign(kMax), rel = (i) => (me[i].lat - rv[i].lat) * sg; // > 0: we are on the inside of the rival
    let side = 0, cnt = 0; for (let i = i0; i <= iA; i++) { side += rel(i); cnt++; }
    side = cnt ? side / cnt : rel(e);
    const ovApex = dp(iA) < CAR_L; // alongside or ahead by the apex
    // Braking points for this corner, as race progress: the start of the last brake application before the apex.
    // lateBrakeM > 0: we braked further down the road than the rival did.
    const onset = (c) => { let i = iA; while (i >= pre && c[i].br <= 0.3) i--; if (i < pre) return null; while (i > pre && c[i - 1].br > 0.3) i--; return c[i].p; };
    const bm = onset(me), br = onset(rv), lateBrakeM = bm !== null && br !== null ? +(bm - br).toFixed(1) : null;
    const corner = { ...base, inside: +side.toFixed(2), ovApex, lateBrakeM, radius: Math.round(1 / Math.abs(kMax)) };
    // A dive brakes no earlier than the rival (2 m tolerance; or brakes where the rival does not need to): an inside
    // pass made while braking earlier is corner speed, not a dive.
    const late = bm === null ? br !== null || null : br === null ? false : bm - br >= -2;
    if (ovApex && side > 0.7) return late === false ? { kind: 'pace', reason: 'inside-speed', ...corner } : { kind: 'dive', ...corner };
    if (ovApex && side < -0.7) return { kind: 'outside', ...corner };
    // Switchback: the rival inside of us on entry, we behind it at the apex, inside of it at the swap.
    let entry = 0; for (let i = pre; i <= iA; i++) entry = Math.min(entry, rel(i));
    if (!ovApex && entry < -0.7 && rel(e) > 0.7) return { kind: 'switchback', ...corner };
    return { kind: 'pace', reason: 'exit', ...corner };
  }

  let lastT = race.time;
  function update() {
    const t = race.time, dt = t - lastT; lastT = t;
    race.entries.forEach((e, j) => { if (e.pit) pitAt[j] = t; });
    if (race.formation) return;
    if (t - lastSample >= 1 / HZ - 1e-6) { sample(t); lastSample = t; }
    for (const s of seats) {
      const me = s.me, slot = s.slot;
      if (me.race.finishTime !== null || me.race.dq) continue;
      cars.forEach((c, j) => {
        if (c === me) return;
        const x = s.st[j], dprog = c.race.progress - me.race.progress;
        const out = Math.abs(dprog) > L / 2 || t - pitAt[j] < 10 || t - pitAt[slot] < 10 || c.race.finishTime !== null || c.race.dq;
        const ahead = dprog < 0, along = Math.abs(dprog) < CAR_L && Math.abs(c.lateral - me.lateral) > CAR_W * 0.7;
        if (out) { x.ahead = ahead; x.pend = false; x.att = null; return; }
        // Attempts: alongside a car that was ahead. One ends when we fall back over two lengths for a second.
        if (!x.att && along && !ahead) x.att = { t0: t, best: dprog, tBest: t };
        if (x.att) {
          if (dprog < x.att.best) { x.att.best = dprog; x.att.tBest = t; }
          if (dprog > 2 * CAR_L) { x.back += dt; if (x.back > 1 && !x.pend) { s.attempts.push({ rival: j, t: +x.att.t0.toFixed(1), done: false, ...classify(slot, j, x.att.tBest) }); x.att = null; } }
          else x.back = 0;
        }
        if (ahead !== x.ahead) { x.ahead = ahead; x.since = t; x.pend = true; }
        if (x.pend && t - x.since >= hold) {
          x.pend = false;
          if (x.ahead) {
            const m = classify(slot, j, x.since), p = { rival: j, t: +x.since.toFixed(1), lap: me.race.lap, s: Math.round(me.s % L), ...m };
            s.passes.push(p); s.attempts.push({ rival: j, t: +(x.att?.t0 ?? x.since).toFixed(1), done: true, kind: m.kind });
            x.att = null;
          } else s.lost.push({ rival: j, t: +x.since.toFixed(1), ...classify(j, slot, x.since) });
        }
      });
    }
  }

  function result(slot) {
    const s = seats.find((x) => x.slot === slot), count = (a) => Object.fromEntries(KINDS.map((k) => [k, a.filter((p) => p.kind === k).length]));
    const att = Object.fromEntries(KINDS.map((k) => { const a = s.attempts.filter((p) => p.kind === k); return [k, [a.filter((p) => p.done).length, a.length]]; }));
    return { mvPasses: s.passes.filter((p) => p.kind !== 'pace').length, mvKinds: count(s.passes), mvAttempts: att, mvLostKinds: count(s.lost),
      mvList: s.passes, mvFailed: s.attempts.filter((p) => !p.done) };
  }

  return { update, result };
}
