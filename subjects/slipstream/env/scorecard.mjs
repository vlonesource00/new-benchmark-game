// Per-seat combat scorecard for a real race, the rules of env/racecraft.mjs for any number of scored seats.
// Race passes and places lost: order changes in race progress (same lap) that hold HOLD s; a pass is clean when
// the scored car had no contact with any car and no time off track from closing within CLOSE s (or from the swap)
// until it held. Order changes through either car's pit cycle (lane + 10 s) or at the finish are not passes.
// Lapped traffic (cars a lap or more apart): on-track swaps that hold HOLD s, counted apart as traffic passes
// (we lapped them) and lapped-by events (they lapped us), each with the contact time in its window.
// Contact geometry per physics tick in contact (from the pairs the stewards consume), by on-track position:
// nose (the other car more than half a length ahead: we ran into it), tail (it ran into us), side (overlapping).
//   const sc = scorecards(race, slots, track); ... after each env.step: sc.update(); ... sc.result(slot)
const CAR_W = 2.0, CAR_L = 4.7;

export function scorecards(race, slots, track, { hold = 3, close = 1.0, open = 1.5 } = {}) {
  const cars = race.cars, L = track.length, n = cars.length;
  const wrap = (d) => ((d % L) + L * 1.5) % L - L / 2; // on-track gap, -L/2..L/2
  const pitAt = new Array(n).fill(-1e9);
  const seats = slots.map((slot) => {
    const me = cars[slot];
    return { slot, me, st: cars.map((c) => ({ ahead: c === me ? null : me.race.progress > c.race.progress, since: 0, closeAt: null, pend: null, win: null,
      on: null, onSince: 0, onPend: null, onWin: null })),
    passes: [], lost: [], traffic: [], lappedBy: [], rubTicks: 0, kinds: { nose: 0, tail: 0, side: 0 }, maxImpact: 0, minClr: Infinity,
    alongLat: new Array(n).fill(0), stuck: 0, pitS: 0, invalidLaps: 0, laps: [], lapSeen: me.race.lap };
  });
  const st0 = race.stewards;
  if (st0) {
    const step = st0.step.bind(st0);
    st0.step = (dt) => {
      for (const s of seats) {
        let mine = false;
        for (const [i, j, closing] of st0.pairs) if (i === s.slot || j === s.slot) {
          mine = true; s.maxImpact = Math.max(s.maxImpact, closing ?? 0);
          const dp = wrap(cars[i === s.slot ? j : i].s - s.me.s);
          s.kinds[dp > CAR_L / 2 ? 'nose' : dp < -CAR_L / 2 ? 'tail' : 'side'] += 1 / 120;
        }
        if (mine) s.rubTicks++;
      }
      return step(dt);
    };
  }
  const win = (s) => ({ rub: s.rubTicks, off: s.me.race.offtrack, clr: Infinity, kinds: { ...s.kinds } });
  const closeWin = (s, w) => ({ contactS: +((s.rubTicks - w.rub) / 120).toFixed(2), offS: +(s.me.race.offtrack - w.off).toFixed(2),
    kinds: Object.fromEntries(Object.entries(s.kinds).map(([k, v]) => [k, +(v - w.kinds[k]).toFixed(2)])) });
  let last = race.time;

  function update() {
    const t = race.time, dt = t - last; last = t;
    race.entries.forEach((e, j) => { if (e.pit) pitAt[j] = t; });
    if (race.formation) return;
    for (const s of seats) {
      const me = s.me, slot = s.slot, v = Math.max(me.speed, 10);
      if (me.race.lap !== s.lapSeen) { s.lapSeen = me.race.lap; s.laps.push({ t: +(me.race.lastLap ?? 0).toFixed(2), valid: me.race.lastState !== 'red' }); if (me.race.lastState === 'red') s.invalidLaps++; }
      if (me.race.finishTime !== null || me.race.dq) continue;
      let behindClose = false;
      cars.forEach((c, j) => {
        if (c === me) return;
        const x = s.st[j], dprog = c.race.progress - me.race.progress, don = wrap(c.s - me.s);
        if (Math.abs(don) < 10) { const clr = Math.max(Math.abs(don) - CAR_L, Math.abs(c.lateral - me.lateral) - CAR_W); s.minClr = Math.min(s.minClr, clr); if (x.win) x.win.clr = Math.min(x.win.clr, clr); }
        const inPit = t - pitAt[j] < 10 || t - pitAt[slot] < 10 || c.race.finishTime !== null || c.race.dq;
        // Lapped traffic: on-track swaps between cars a lap or more apart.
        if (Math.abs(dprog) > L / 2) {
          x.ahead = dprog < 0; x.pend = null; x.closeAt = null; x.win = null;
          if (inPit || Math.abs(don) > 40) { x.on = null; x.onPend = null; x.onWin = null; return; }
          const onAhead = don < 0; // we are ahead of it on track
          if (x.on === null) { x.on = onAhead; return; }
          if (Math.abs(don) < 30) x.onWin ??= win(s);
          if (onAhead !== x.on) { x.on = onAhead; x.onSince = t; x.onPend = { weLap: dprog < 0 }; x.onWin ??= win(s); }
          if (x.onPend && t - x.onSince >= hold) {
            const w = closeWin(s, x.onWin ?? win(s)), ev = { rival: j, t: +t.toFixed(1), ...w, clean: w.contactS === 0 && w.offS < 1e-9 };
            if (x.onPend.weLap && x.on) s.traffic.push(ev); else if (!x.onPend.weLap && !x.on) s.lappedBy.push(ev);
            x.onPend = null; x.onWin = null;
          }
          return;
        }
        x.on = null; x.onPend = null; x.onWin = null;
        const gap = dprog / v; // s; > 0 = rival ahead in the race
        if (inPit) { x.ahead = gap < 0; x.pend = null; x.closeAt = null; return; }
        if (gap > 0 && gap < close) { behindClose = true; if (x.closeAt === null) { x.closeAt = t; x.win ??= win(s); } }
        if (gap > open) { x.closeAt = null; if (!x.pend) x.win = null; }
        if (Math.abs(dprog) < 5) s.alongLat[j] = Math.max(s.alongLat[j], Math.abs(c.lateral - me.lateral));
        else if (Math.abs(dprog) > 30) s.alongLat[j] = 0;
        const ahead = gap < 0;
        if (ahead !== x.ahead) { x.ahead = ahead; x.since = t; x.pend = ahead ? { closeAt: x.closeAt ?? t } : { lost: true }; if (ahead) x.win ??= win(s); }
        if (x.pend && t - x.since >= hold) {
          if (x.pend.lost) s.lost.push({ rival: j, t: +t.toFixed(1) });
          else {
            const w = x.win ?? win(s), cw = closeWin(s, w);
            s.passes.push({ rival: j, t: +t.toFixed(1), took: +(x.since - x.pend.closeAt).toFixed(1), lap: me.race.lap, sepM: +s.alongLat[j].toFixed(2),
              clean: cw.contactS === 0 && cw.offS < 1e-9, ...cw, minClrM: Number.isFinite(w.clr) ? +w.clr.toFixed(2) : null });
          }
          x.pend = null; x.win = null; if (!x.ahead) x.closeAt = null;
        }
      });
      if (behindClose) s.stuck += dt;
      if (race.entries[slot].pit) s.pitS += dt;
    }
  }

  function result(slot) {
    const s = seats.find((x) => x.slot === slot), me = s.me, sw = race.stewards?.of(race.entries[slot]) ?? {};
    const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
    return { passes: s.passes.length, cleanPasses: s.passes.filter((p) => p.clean).length, passedBy: s.lost.length,
      traffic: s.traffic.length, trafficClean: s.traffic.filter((p) => p.clean).length, lappedBy: s.lappedBy.length, lappedByContact: s.lappedBy.filter((p) => p.contactS > 0).length,
      offS: +me.race.offtrack.toFixed(2), invalidLaps: s.invalidLaps, maxImpact: +s.maxImpact.toFixed(2), minClrM: Number.isFinite(s.minClr) ? +s.minClr.toFixed(2) : null,
      medianTook: med(s.passes.map((p) => p.took)), medianSepM: med(s.passes.map((p) => p.sepM)), stuckS: +s.stuck.toFixed(1), rubS: +(s.rubTicks / 120).toFixed(2),
      rubKinds: Object.fromEntries(Object.entries(s.kinds).map(([k, v]) => [k, +v.toFixed(2)])), inc: sw.inc ?? 0, penalties: (sw.penalties ?? []).length,
      damage: +me.damage.toFixed(3), pitS: +s.pitS.toFixed(1), laps: s.laps, passList: s.passes, lostList: s.lost, trafficList: s.traffic, lappedByList: s.lappedBy,
      incLog: (sw.log ?? []).map((l) => [+l.time.toFixed(1), l.kind, l.points]) };
  }

  return { update, result };
}
