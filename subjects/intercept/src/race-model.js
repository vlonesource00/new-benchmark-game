// Full-information field projector for the INTERCEPT race strategist (STRATEGY-PLAN.md P1).
// Reads the whole race (every car's true tyres, fuel, timing, every team's strategist, the seeded weather) and
// projects every car lap by lap to the flag: line-crossing times, stops, finishing order. Read-only: rival
// strategists are only ever queried on copies, the shared road outlook's cache is never touched, nothing on the
// race or its cars is written.
import { RoadOutlook } from '../../../game/core/road-outlook.js';
import { wrap } from '../../../game/engine/sim/math.js';
import { serviceTime, TANK_LITRES, WEAR_CLIFF, WET_COMPOUNDS } from '../../../game/core/rules.js';
import { maxWear, wetPace } from '../../../game/core/strategy.js';
import { classProfile } from '../../../game/core/classes.js';
import { CAUTION } from '../../../game/core/caution.js';

const STEP = 5;                       // s per extended forecast step (the outlook's own step)
const wearLoss = (w) => 0.10 * w + 1.2 * Math.max(0, w - WEAR_CLIFF) ** 2;   // the tyre model's grip loss (core/strategy.js)
const family = (id) => (WET_COMPOUNDS[id] ? id : 'slick');

/** A strategist copy that can be asked anything without changing the original (own arrays, own memo, own env). */
export function cloneStrategist(s, env) {
  const proto = Object.getPrototypeOf(s), c = Object.assign(Object.create(proto), s);
  for (const k of Object.keys(c)) {
    const v = c[k];
    // Instance wrappers (loggers, the tracker) call back into the original: the copy uses the class methods.
    if (typeof v === 'function' && k in proto) delete c[k];
    else if (Array.isArray(v)) c[k] = v.map((x) => (Array.isArray(x) ? [...x] : x && Object.getPrototypeOf(x) === Object.prototype ? { ...x } : x));
    else if (v instanceof Map) c[k] = new Map(v);
    else if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) c[k] = { ...v };
  }
  // __projected: the copy runs inside a projection (a planning strategist must not project again from there).
  delete c.__tracked; c.memo = null; c.__projected = true;
  if (env) c.env = env;
  return c;
}

/**
 * Weather to the flag: the outlook's own road model (live water field, seeded sky, learnt traffic clearing) stepped
 * from now to `until`, without touching the outlook's shared forecast cache. `envAt(t)` is an env for strategist
 * copies that see the road as it will be at race time t.
 */
export class WeatherView {
  constructor(race, until) {
    this.race = race; this.t0 = race.time; const o = race.outlook;
    this.f = null;
    // The sky is built by the race's own outlook update (never here: its length depends on when it is first built).
    if (o?.sky && race.track.water?.live) {
      const n = Math.max(1, Math.ceil(Math.max(0, until - race.time) / STEP)), d = o.sample(), wet = new Float32Array(n + 1), es = o.evapScale(race.time);
      wet[0] = o.lineWet(d);
      for (let q = 1; q <= n; q++) { o.advance(d, race.time + (q - 1) * STEP, STEP, es, true); wet[q] = o.lineWet(d); }
      this.f = { t0: race.time, step: STEP, wet, now: wet[0] };
    }
  }
  /** Mean predicted racing-line wetness over race times [a, b]. */
  wet(a, b = a) {
    if (!this.f) return this.race.track.wetness ?? 0;
    return RoadOutlook.mean(this.f, Math.max(0, a - this.t0), Math.max(0, b - this.t0));
  }
  /** Forecast as a strategist would read it at race time t (the extended forecast, re-based to t). */
  forecastAt(t) {
    if (!this.f) return null;
    const off = Math.max(0, Math.round((t - this.t0) / STEP)), wet = this.f.wet.subarray(Math.min(off, this.f.wet.length - 1));
    return { t0: t, step: STEP, wet, now: wet[0] };
  }
  envAt(t) {
    const r = this.race, track = Object.create(r.track);
    track.wetness = this.wet(t);
    return { track, weather: r.weather, clock: () => t, outlook: { forecast: () => this.forecastAt(t) } };
  }
}

/**
 * Per-car measurements from every line crossing: true fuel burn and tread wear per lap, and clean lap times with the
 * state they were driven in, for the pace fit. Fed by a pass-through wrapper on each entry's strategist.observeLap
 * (the original runs unchanged).
 */
export class FieldTracker {
  constructor(race) {
    this.race = race;
    this.cars = race.cars.map(() => ({ laps: [], fuelPerLap: null, wearPerLap: {}, mark: null }));
    race.entries.forEach((e, i) => this.watch(e, i));
  }
  watch(e, i) {
    const s = e.strategist; if (s.__tracked) return;
    const observe = s.observeLap, self = this;
    s.observeLap = function (car, clean) { self.lap(i, car, clean); return observe.call(this, car, clean); };
    s.__tracked = true;
  }
  /** Re-wrap strategists an installer replaced after the tracker was built. */
  refresh() { this.race.entries.forEach((e, i) => this.watch(e, i)); }
  lap(i, car, clean) {
    const T = this.cars[i], r = car.race, id = car.wheels[0].tyre.compound, yellow = Boolean(this.race.caution?.active);
    const now = { fuel: car.fuel, wear: maxWear(car), compound: id, stint: this.race.entries[i].strategist.stintLaps, yellow };
    if (T.mark && T.mark.compound === id && now.wear >= T.mark.wear && !this.race.entries[i].lapHadPit) {
      const dw = now.wear - T.mark.wear, df = T.mark.fuel - now.fuel;
      if (df > 0) T.fuelPerLap = T.fuelPerLap == null ? df : T.fuelPerLap * 0.5 + df * 0.5;
      if (dw > 0) T.wearPerLap[id] = T.wearPerLap[id] == null ? dw : T.wearPerLap[id] * 0.5 + dw * 0.5;
    }
    // Lap row: state at the start of the lap (the mark) and its time. Only clean green-flag laps feed the pace fit.
    if (T.mark && clean && r.lap > 1 && !yellow && !T.mark.yellow && r.lastLap) T.laps.push({ lap: r.lap, time: r.lastLap, compound: T.mark.compound, wear: (T.mark.wear + now.wear) / 2, fuel: (T.mark.fuel + now.fuel) / 2, wet: this.race.track.wetness ?? 0, stint: now.stint });
    T.mark = now;
  }
}

/**
 * Lap time model per car, from its own clean laps: base pace on a fresh medium at reference fuel, plus the fuel
 * load, the tread (the tyre model's grip loss, scaled per car) and the wet road for the tyre family. The fuel and
 * fade terms start from the game's planner model; `fit` re-solves the car's base and fade from its laps.
 */
export class PaceModel {
  constructor(race, tracker) {
    this.race = race; this.tracker = tracker;
    this.ref = race.cal.refLap ?? race.track.length / 50;
    // A car's lap before it has run a clean one: the class's reference lap on this circuit, scaled to the early race laps
    // (median 0.95 of it over laps 2-4 in the ds1/shadow-d races; the game's
    // calibration guess, length / 50, is ~15 % fast).
    this.classLap = (id) => (classProfile(race.track, id)?.lap ?? this.ref) * 0.955;
    this.fuelK = 0.03;               // s per litre (re-fitted from the logs; STRATEGY-PLAN.md P1)
    this.offset = { soft: -0.016, medium: 0, hard: 0.022 };
  }
  terms(c, lap) {
    const ref = this.ref;
    return { comp: ref * (this.offset[lap.compound] ?? 0), fuel: this.fuelK * lap.fuel, wear: ref * 0.45 * wearLoss(lap.wear), wet: ref * wetPace(family(lap.compound), lap.wet ?? 0) };
  }
  /** Base and fade of car i: least squares on its clean laps, base = lap - comp - fuel - wet - fade * wear. */
  fit(i) {
    const all = this.tracker.cars[i].laps.slice(-12), e = this.race.entries[i];
    // Slow laps (traffic, a moment off line) are not pace: drop anything 4 % over the car's median.
    const med = [...all].map((l) => l.time).sort((a, b) => a - b)[all.length >> 1], laps = all.filter((l) => l.time <= med * 1.04);
    // No clean lap yet: the car's own strategist's lap reference (the race's bestLap counts the standing lap).
    if (!laps.length) { const c = this.race.cars[i]; return { base: this.classLap(c.classId ?? this.race.classId) - this.fuelK * c.fuel, fade: 1 }; }
    const rows = laps.map((l) => { const t = this.terms(i, l); return { y: l.time - t.comp - t.fuel - t.wet, x: t.wear }; });
    let fade = 1;
    const mx = rows.reduce((s, r) => s + r.x, 0) / rows.length, my = rows.reduce((s, r) => s + r.y, 0) / rows.length;
    const sxx = rows.reduce((s, r) => s + (r.x - mx) ** 2, 0);
    if (rows.length >= 4 && sxx > 0.05) fade = Math.min(2.5, Math.max(0.5, rows.reduce((s, r) => s + (r.x - mx) * (r.y - my), 0) / sxx));
    // Robust base: median residual after the fade term.
    const res = rows.map((r) => r.y - fade * r.x).sort((a, b) => a - b);
    return { base: res[Math.floor(res.length / 2)], fade };
  }
  lapTime(fitted, compound, wear, fuel, wet) {
    const t = this.terms(null, { compound, wear, fuel, wet });
    return fitted.base + t.comp + t.fuel + t.wet + fitted.fade * t.wear;
  }
}

/**
 * The projector. `project(override)` runs every car to the flag; `override(i, lap, state)` may return a stop plan
 * for car i at the end of that lap (null = stay out, undefined = ask the car's own strategist copy).
 */
export class FieldModel {
  constructor(race) {
    this.race = race; this.tracker = new FieldTracker(race); this.pace = new PaceModel(race, this.tracker);
    this.laneLoss = null;            // s: lane transit over a racing lap at the same spot (measured from stops)
    // Where the lap's time goes: the class's speed trace on this circuit, as cumulative time from s = 0.
    const P = classProfile(race.track, race.classId) ?? classProfile(race.track, 'gt');
    if (P) { const n = P.v.length, cum = new Float64Array(n + 1); for (let q = 0; q < n; q++) cum[q + 1] = cum[q] + P.bin / Math.max(5, P.v[q]); this.prof = { n, cum }; }
    const lane = race.lane, line = race.track.finishS ?? 0;
    // Share of a lap's time from the line to the race's strategy call (Race: 120 m before the pit approach).
    this.decShare = lane ? this.share(line, wrap(lane.approach - 120, race.track.length)) : 0.88;
  }
  /** Share of a racing lap's time from track position a forward to b (0..1). */
  share(a, b) {
    const L = this.race.track.length, P = this.prof;
    if (!P) return wrap(b - a, L) / L;
    const at = (x) => { const u = (wrap(x, L) / L) * P.n, q = Math.min(P.n - 1, Math.floor(u)); return P.cum[q] + (u - q) * (P.cum[q + 1] - P.cum[q]); };
    const d = at(b) - at(a), T = P.cum[P.n];
    return (d < 0 ? d + T : d) / T;
  }
  /**
   * A car with a stop under way or called for this lap: time to its next line crossing along the path it will drive
   * (track to the entry, lane at the limit, the service, lane to the exit, the brake/launch loss), and the part of
   * the stop's loss that falls after that crossing (the line sits inside the lane on Harbor Ring).
   */
  pitPath(e, c, plan, lapT) {
    const race = this.race, lane = race.lane, L = race.track.length, line = race.track.finishS ?? 0, p = e.pit, phase = p?.phase ?? 'approach';
    const dist = (a, b) => wrap(b - a, L), s = wrap(c.s, L), lim = lane.limit, half = 1.65;
    const repair = plan.repair ?? ((c.damage ?? 0) >= 0.05 ? c.damage : 0);
    const svc = plan.penalty ? 0 : phase === 'service' ? (p.serviced ? 0.5 : Math.max(0, p.serviceLeft)) : phase === 'release' ? 0.5 : serviceTime(race.cal, plan) + repair * 30;
    // Segments by forward distance from s: [from, to, timeAtFrom, timeAtTo].
    const seg = []; let d = 0, t = 0;
    const go = (to, kind) => { const len = dist(wrap(s + d, L), to); const dt = kind === 'race' ? lapT * this.share(wrap(s + d, L), to) : len / lim; seg.push([d, d + len, t, t + dt]); d += len; t += dt; };
    if (phase === 'approach') { go(lane.entry, 'race'); t += half; }
    if (phase === 'approach' || phase === 'lane') go(e.box, 'lane');
    if (phase !== 'release') t += svc;
    go(lane.exit, 'lane'); t += half;
    const dExit = d, tExit = t, dLine = dist(s, line);
    if (dLine >= dExit) return { toLine: tExit + lapT * this.share(lane.exit, line), carry: 0 };
    const g = seg.find(([a, b]) => dLine >= a && dLine <= b) ?? seg.at(-1);
    const toLine = g[2] + (g[3] - g[2]) * (g[1] > g[0] ? (dLine - g[0]) / (g[1] - g[0]) : 1);
    return { toLine, carry: Math.max(0, tExit - toLine - lapT * this.share(line, lane.exit)) };
  }
  /** Lane transit loss: INTERCEPT's per-track estimate until measured. */
  lane() {
    if (this.laneLoss != null) return this.laneLoss;
    const L = this.race.lane, ref = this.pace.ref;
    return L?.length && L.limit ? Math.max(10, L.length / L.limit - L.length / Math.max(20, (L.L ?? this.race.track.length) / ref)) : 18;
  }
  /**
   * In-lap + out-lap loss of a stop over two racing laps: the lane transit, the deceleration/acceleration it leaves
   * out (+3.3 s: median of 18 stops, Harbor classic s1, 2026-10-17: loss = service + 22.4 s), the service and the
   * repair the pit adds for the car's damage (30 s per unit, as the service clock).
   */
  stopCost(plan, damage = 0) { return this.lane() + 3.3 + serviceTime(this.race.cal, plan) + (plan.repair ?? (damage >= 0.05 ? damage : 0)) * 30; }

  /** Snapshot of every car at its next line crossing, the starting state for a projection. */
  start(fresh = -1) {
    const race = this.race, now = race.time, until = now + (race.laps + 2) * this.pace.ref * 1.3;
    const weather = new WeatherView(race, until);
    const cars = race.cars.map((c, i) => {
      const e = race.entries[i], r = c.race, fit = this.pace.fit(i), T = this.tracker.cars[i];
      const done = r.finishTime !== null || e.retired;
      const comp = c.wheels[0].tyre.compound, wear = maxWear(c);
      const lapT = this.pace.lapTime(fit, comp, wear, c.fuel, weather.wet(now));
      // Where the car is in its lap (share of a racing lap's time from the line) and its next crossing.
      const line = race.track.finishS ?? 0, held = r.progress <= 0 ? 0 : this.share(line, c.s);
      // `fresh`: the car whose call is being made right now (its decidedLap is already set).
      let plan = e.pit || (e.pitPlan && r.finishTime === null && i !== fresh) ? e.pitPlan : null, toLine = lapT * (1 - held);
      if (r.progress <= 0) toLine = lapT * this.share(c.s, line) + lapT;
      if (plan) { const P = this.pitPath(e, c, plan, lapT); toLine = P.toLine; plan = { ...plan, carry: P.carry, applied: Boolean(e.pit?.serviced) }; }
      return { i, done, finish: r.finishTime, lap: r.lap, frac: held, decided: e.decidedLap === r.lap && i !== fresh, t: now + toLine, compound: comp, wear, fuel: c.fuel, stint: e.strategist.stintLaps,
        stops: e.strategist.stops, swaps: e.strategist.swaps, fit, fuelPerLap: T.fuelPerLap ?? e.strategist.fuelPerLap,
        wearRate: (id) => T.wearPerLap[id] ?? e.strategist.wearPerLap?.[id] ?? 0.05, pitNow: plan,
        strat: cloneStrategist(e.strategist), damage: c.damage ?? 0, crossings: [], stopsAt: [] };
    });
    return { now, weather, cars };
  }

  project(override = () => undefined, { fresh = -1 } = {}) {
    const race = this.race, N = race.laps, S = this.start(fresh), cars = S.cars, fd = this.decShare;
    const C = this.cautionState(S.now);
    if (C) this.seedCaution(S, C, override);
    // Each car lap by lap to lap N: the call at its decision point (on the state it will have there), the line
    // crossing, then the stop (in-lap + out-lap loss) and the next lap on the state after it.
    for (const k of cars) {
      if (k.done) continue;
      let t = k.seeded ? k.crossings.at(-1) : k.t, pending = null, stopLap = false;
      // The copy learns from each projected lap as the real one does (Race.lapComplete -> observeLap): pace,
      // fade, wear and fuel rates and the stint mark. A seeded car only resets its mark (caution laps teach nothing).
      const learn = (lap, lapT, clean) => { try { k.strat.observeLap(this.stub(race.cars[k.i], k, lap, lapT), clean); } catch { /* copy state only */ } };
      if (k.seeded) learn(k.lapNext - 1, null, false);
      for (let lap = k.seeded ? k.lapNext : k.lap; lap <= N; lap++) {
        const cur = !k.seeded && lap === k.lap, rate = k.wearRate(k.compound);
        if (!cur) {
          let add = 0;
          if (pending) {
            const plan = pending;
            // A stop already under way has its loss up to the line in that crossing: only the carry is left.
            add = plan.carry ?? this.stopCost(plan, k.damage); k.damage = 0;
            if (!plan.applied && !plan.penalty) {
              if (plan.tyres) { k.compound = plan.compound; k.wear = 0; }
              k.fuel = Math.min(TANK_LITRES, k.fuel + (plan.litres ?? 0)); k.stops += 1; if (plan.swap) k.swaps += 1; k.stint = 0;
              k.strat.stopDone?.(plan);
            }
            k.stopsAt.push({ lap: lap - 1, compound: plan.tyres ? plan.compound : null, litres: plan.litres ?? 0, swap: Boolean(plan.swap) });
            pending = null; stopLap = true;
          }
          const r2 = k.wearRate(k.compound), wet = S.weather.wet(t, t + this.pace.ref);
          t += this.pace.lapTime(k.fit, k.compound, k.wear + r2 / 2, Math.max(0, k.fuel - k.fuelPerLap / 2), wet) + add;
        }
        // The call for the end of this lap.
        let plan = null;
        if (cur && (k.pitNow || k.decided)) plan = k.pitNow;
        else {
          const held = cur ? k.frac : 0, ahead = Math.max(0, fd - held), lapT = cur ? k.t - S.now : t - k.crossings.at(-1);
          const at = { ...k, wear: Math.min(1, k.wear + k.wearRate(k.compound) * ahead), fuel: Math.max(0, k.fuel - k.fuelPerLap * ahead) };
          const o = override(k.i, lap, at);
          if (o !== undefined) plan = o;
          else {
            const tD = cur ? S.now + (k.t - S.now) * ahead / Math.max(1e-3, 1 - held) : t - lapT * (1 - fd);
            const car = this.stub(race.cars[k.i], at, lap);
            k.strat.env = S.weather.envAt(tD); k.strat.stintLaps = k.stint;
            try {
              plan = k.strat.decide(car, N - lap + 1, true, false);
              // The race re-plans the service at the box (Race.beginService): that plan is what the car gets.
              if (plan && !plan.penalty && lap < N) plan = { ...plan, ...k.strat.servicePlan(car, Math.max(0, N - lap)) };
              if (lap >= N) plan = null;
            } catch { plan = null; }
          }
        }
        // To the line: the rest of this lap's wear and fuel.
        const rest = cur ? 1 - k.frac : 1;
        k.wear = Math.min(1, k.wear + rate * rest); k.fuel = Math.max(0, k.fuel - k.fuelPerLap * rest); k.stint += 1;
        const prevT = k.crossings.at(-1) ?? (cur ? race.cars[k.i].race.lapStart : null);
        k.crossings.push(t);
        learn(lap, prevT == null ? null : t - prevT, !stopLap && !(cur && k.pitNow?.applied) && !plan);
        pending = plan; stopLap = false;
      }
    }
    this.traffic(S);
    return this.classify(S);
  }
  /**
   * The caution in force now, if any: when racing resumes (race control's own rules, core/caution.js), the field's
   * pace until then, and whether it is a safety car (the field queues up) or a full course yellow (gaps hold).
   */
  cautionState(now) {
    const race = this.race, rc = race.caution; if (!rc?.active || race.formation) return null;
    const L = race.track.length, lane = race.lane, line = race.track.finishS ?? 0, t = now - rc.since;
    const sc = rc.phase === 'sc' || rc.phase === 'in' || Boolean(rc.escalate);
    // Field pace: the safety car's lap (Harbor's lap 2 under SC: ~100 s = 27 m/s); FCY at the 80 km/h limit, bends below it.
    const v = sc ? 27 : 20;
    let tGreen;
    if (rc.phase === 'ending') tGreen = now + Math.max(0, CAUTION.ending - t);
    else if (!sc) tGreen = now + Math.max(0, CAUTION.fcyMin - t) + CAUTION.clearFor + CAUTION.ending + 2;
    else if (rc.phase === 'in' && rc.released) {
      const front = Math.max(...(rc.queue ?? []).map((id) => race.cars[id].race.progress), -Infinity);
      tGreen = now + (Number.isFinite(front) ? Math.max(0, rc.restartAt - front) : 0) / v;
    } else {
      // SC in once the queue has formed (at least 25 s out), then the leader runs to the restart point behind it.
      const restartS = lane.d(lane.entry, line) <= 700 ? line : wrap(lane.entry + 400, L), leader = race.order()[0];
      const tIn = now + (rc.phase === 'in' ? 0 : Math.max(rc.phase === 'sc' ? 25 - t : 25, rc.formed ? 0 : 30, 0) + (rc.phase === 'fcy' ? 10 : 0));
      let d = lane.d(wrap(leader.s + v * (tIn - now), L), restartS); if (d < 150) d += L;
      tGreen = tIn + d / v;
    }
    return { sc, v, tGreen, open: rc.pitsOpen, kind: sc ? 'sc' : 'fcy' };
  }
  /**
   * Every running car through the caution to its first crossing after the green flag: its strategy call at the next
   * decision point before the green (asked with the caution flag, as the race asks), a stop's cost at caution pace
   * (lane at the limit against the field's pace, plus service), and the restart order. Under a safety car the field
   * closes up 12 m apart behind the leader in order of progress, stopped cars rejoining where their loss puts them;
   * under a yellow, gaps hold. Wear runs at 0.3x and fuel at 0.9x at caution pace (Harbor s1 SC laps).
   */
  seedCaution(S, C, override) {
    const race = this.race, L = race.track.length, lane = race.lane, line = race.track.finishS ?? 0, N = race.laps;
    const now = S.now, span = Math.max(0, C.tGreen - now), winS = wrap(lane.approach - 120, L), run = [];
    for (const k of S.cars) {
      if (k.done) continue;
      const c = race.cars[k.i], P = c.race.progress; if (P <= 0) continue;
      const rate = k.wearRate(k.compound);
      let loss = 0, plan = null;
      if (k.pitNow) { plan = k.pitNow; loss = plan.applied ? 0 : serviceTime(race.cal, plan) + (plan.repair ?? (k.damage >= 0.05 ? k.damage : 0)) * 30 + 3.3; }
      else {
        // The next call: this lap's window unless already asked (pits open) or passed; then next lap's.
        const dW = lane.d(wrap(c.s, L), winS), winLap = k.decided || k.frac >= this.decShare ? k.lap + 1 : k.lap;
        const dist = k.decided && dW < L / 2 ? dW + L : dW, tW = now + dist / C.v;
        if (tW < C.tGreen && winLap < N && (C.open || tW - now > CAUTION.scPits)) {
          const at = { ...k, wear: Math.min(1, k.wear + rate * 0.3 * dist / L), fuel: Math.max(0, k.fuel - k.fuelPerLap * 0.9 * dist / L) };
          const o = override(k.i, winLap, at, C);
          if (o !== undefined) plan = o;
          else {
            const car = this.stub(c, at, winLap);
            k.strat.env = S.weather.envAt(tW); k.strat.stintLaps = k.stint;
            try {
              plan = k.strat.decide(car, N - winLap + 1, true, C.kind);
              if (plan && !plan.penalty) plan = { ...plan, ...k.strat.servicePlan(car, Math.max(0, N - winLap)) };
            } catch { plan = null; }
          }
          if (plan) {
            loss = serviceTime(race.cal, plan) + (plan.repair ?? (k.damage >= 0.05 ? k.damage : 0)) * 30 + 3.3 + Math.max(0, lane.length / lane.limit - lane.length / C.v);
            k.stopsAt.push({ lap: winLap, compound: plan.tyres ? plan.compound : null, litres: plan.litres ?? 0, swap: Boolean(plan.swap), caution: C.kind });
          }
        }
      }
      if (plan && !plan.applied && !plan.penalty) {
        if (plan.tyres) { k.compound = plan.compound; k.wear = 0; }
        k.fuel = Math.min(TANK_LITRES, k.fuel + (plan.litres ?? 0)); k.stops += 1; if (plan.swap) k.swaps += 1; k.stint = 0;
        k.strat.stopDone?.(plan); k.damage = 0;
      }
      run.push({ k, P, V: P + C.v * span - C.v * loss });
    }
    // Progress at the green flag.
    if (C.sc) {
      run.sort((a, b) => b.V - a.V);
      const head = run[0]?.V ?? 0;
      run.forEach((x, r) => { const down = Math.floor((head - x.V) / L); x.G = Math.min(head - r * 12 - down * L, x.V + 11 * span); });
    } else run.forEach((x) => { x.G = x.V; });
    for (const x of run) {
      const k = x.k, rate = k.wearRate(k.compound), G = Math.max(x.P, x.G);
      for (let m = Math.floor(x.P / L) + 1; m * L <= G; m++) { k.crossings.push(now + (span * (m * L - x.P)) / Math.max(1e-6, G - x.P)); k.stint += 1; }
      const lapT = this.pace.lapTime(k.fit, k.compound, k.wear, k.fuel, S.weather.wet(C.tGreen)), sG = wrap(line + G, L);
      k.crossings.push(C.tGreen + lapT * this.share(sG, line)); k.stint += 1;
      const done = (G - x.P) / L, rest = (Math.floor(G / L) + 1) - G / L;
      k.wear = Math.min(1, k.wear + rate * (0.3 * done + rest)); k.fuel = Math.max(0, k.fuel - k.fuelPerLap * (0.9 * done + rest));
      k.seeded = true; k.lapNext = k.lap + k.crossings.length; k.yellowN = k.crossings.length;
    }
  }
  /**
   * Pit now under the caution, or stay out? Projects the race both ways for car i (its next call before the green:
   * a stop with its own strategist's service plan on fresh tyres, against no stop) and compares the finishing place,
   * then the time. Null when there is no caution or no call left before the green.
   */
  cautionChoice(i) {
    const C = this.cautionState(this.race.time); if (!C) return null;
    let asked = false;
    const as = (pit) => this.project((j, lap, at, c) => {
      if (j !== i || !c) return undefined;
      asked = true; if (!pit) return null;
      const car = this.stub(this.race.cars[i], at, lap), svc = at.strat.servicePlan(car, Math.max(0, this.race.laps - lap));
      return { ...svc, tyres: true, compound: svc.tyres ? svc.compound : at.compound };
    }, { fresh: i });
    const a = as(true), b = as(false); if (!asked) return null;
    const pa = a.cars[i], pb = b.cars[i], gain = pb.place - pa.place, dt = pb.laps === pa.laps ? pb.time - pa.time : 0;
    return { kind: C.kind, tGreen: C.tGreen, pit: { place: pa.place, time: pa.time }, stay: { place: pb.place, time: pb.time }, gain, dt, worth: gain > 0 || (gain === 0 && dt > 1) };
  }
  /** Car-shaped view of a projected state for a strategist copy's decide(). */
  stub(car, k, lap, lastLap) {
    // Each wheel keeps the car's real wear balance, scaled to the projected worst tyre (per-wheel learners difference it).
    const top = maxWear(car);
    const wheels = car.wheels.map((w) => Object.assign(Object.create(w), { tyre: Object.assign(Object.create(w.tyre), { compound: k.compound, wear: top > 0.01 ? k.wear * w.tyre.wear / top : k.wear }) }));
    const race = Object.assign(Object.create(car.race), { lap }); if (lastLap !== undefined) race.lastLap = lastLap;
    return Object.assign(Object.create(car), { fuel: k.fuel, wheels, race });
  }
  /**
   * Traffic: the projection runs each car alone, so a faster car would drive through the field. Lap by lap, in the
   * order at the previous line, a car that closes to within GAP of the car ahead passes only with a lap-pace edge of
   * PASS_EDGE (and pays PASS_COST per pass); otherwise it is held GAP behind. Time lost stays lost. Laps under the
   * caution (already queued) and the in/out laps of a stop (the pit lane bypasses the queue) are left alone.
   */
  traffic(S) {
    const GAP = 0.4, PASS_EDGE = 0.6, PASS_COST = 0.5;
    const live = S.cars.filter((k) => !k.done && k.crossings.length > 1);
    const raw = new Map(live.map((k) => [k, [...k.crossings]]));
    const free = new Map(live.map((k) => [k, new Set([...k.stopsAt.flatMap((s) => [s.lap, s.lap + 1]), ...Array.from({ length: (k.yellowN ?? 0) + 1 }, (_, j) => k.lap + j)])]));
    const N = this.race.laps, first = Math.min(...live.map((k) => k.lap));
    for (let L = first + 1; L <= N; L++) {
      const at = live.filter((k) => L - k.lap >= 1 && L - k.lap < k.crossings.length)
        .sort((a, b) => a.crossings[L - 1 - a.lap] - b.crossings[L - 1 - b.lap]);
      const placed = [];
      for (const k of at) {
        const j = L - k.lap, R = raw.get(k), lapT = R[j] - R[j - 1];
        let t = k.crossings[j - 1] + lapT;
        const off = free.get(k).has(L);
        if (!off) {
          for (let p = placed.length - 1; p >= 0; p--) {
            const A = placed[p];
            if (A.off) continue;              // in the pit lane (or the caution queue): passed for free
            if (t >= A.t + GAP) break;
            if (A.lapT - lapT >= PASS_EDGE) { t = Math.max(t, A.t - GAP) + PASS_COST; continue; }
            t = A.t + GAP; break;
          }
        }
        k.crossings[j] = t; placed.push({ t, lapT, off }); placed.sort((a, b) => a.t - b.t);
      }
    }
  }
  /** Finishing order: the flag falls at the first projected completion of lap N; each car finishes at its next crossing. */
  classify(S) {
    const N = this.race.laps;
    const flag = Math.min(...S.cars.filter((k) => !k.done).map((k) => k.crossings[N - k.lap] ?? Infinity), ...S.cars.filter((k) => k.done && k.finish != null).map((k) => k.finish));
    const out = S.cars.map((k) => {
      if (k.done) return { i: k.i, laps: this.race.cars[k.i].race.finishLaps ?? N, time: k.finish ?? Infinity, stops: [] };
      let laps = k.lap - 1, time = null;
      for (let j = 0; j < k.crossings.length; j++) { laps = k.lap + j; time = k.crossings[j]; if (time >= flag) break; }
      return { i: k.i, laps, time, stops: k.stopsAt, crossings: k.crossings };
    });
    const order = [...out].sort((a, b) => b.laps - a.laps || a.time - b.time);
    order.forEach((o, p) => { o.place = p + 1; });
    return { flag, cars: out, order: order.map((o) => o.i) };
  }
}
