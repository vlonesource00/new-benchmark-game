// Full-information field projector for the INTERCEPT race strategist (STRATEGY-PLAN.md P1).
// Reads the whole race (every car's true tyres, fuel, timing, every team's strategist, the seeded weather) and
// projects every car lap by lap to the flag: line-crossing times, stops, finishing order. Read-only: rival
// strategists are only ever queried on copies, the shared road outlook's cache is never touched, nothing on the
// race or its cars is written.
import { RoadOutlook } from '../../../game/core/road-outlook.js';
import { serviceTime, TANK_LITRES, WEAR_CLIFF, WET_COMPOUNDS } from '../../../game/core/rules.js';
import { maxWear, wetPace } from '../../../game/core/strategy.js';
import { classProfile } from '../../../game/core/classes.js';

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
  delete c.__tracked; c.memo = null;
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
    // A car's lap before it has run a clean one: the class's measured reference lap on this circuit (the game's
    // calibration guess, length / 50, is ~15 % fast).
    this.classLap = (id) => (classProfile(race.track, id)?.lap ?? this.ref) * 1.03;
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
  start() {
    const race = this.race, now = race.time, until = now + (race.laps + 2) * this.pace.ref * 1.3;
    const weather = new WeatherView(race, until);
    const cars = race.cars.map((c, i) => {
      const e = race.entries[i], r = c.race, fit = this.pace.fit(i), T = this.tracker.cars[i];
      const done = r.finishTime !== null || e.retired;
      const comp = c.wheels[0].tyre.compound, wear = maxWear(c);
      const lapT = this.pace.lapTime(fit, comp, wear, c.fuel, weather.wet(now));
      const frac = Math.min(0.999, Math.max(0, (r.progress - (r.lap - 1) * race.track.length) / race.track.length));
      const pitNow = e.pit ? (e.pit.phase === 'approach' ? e.pitPlan : null) : e.pitPlan;
      return { i, done, finish: r.finishTime, lap: r.lap, t: now + (1 - frac) * lapT, compound: comp, wear, fuel: c.fuel, stint: e.strategist.stintLaps,
        stops: e.strategist.stops, swaps: e.strategist.swaps, fit, fuelPerLap: T.fuelPerLap ?? e.strategist.fuelPerLap,
        wearRate: (id) => T.wearPerLap[id] ?? e.strategist.wearPerLap?.[id] ?? 0.05, pitNow, inPit: Boolean(e.pit && e.pit.phase !== 'approach'),
        strat: cloneStrategist(e.strategist), damage: c.damage ?? 0, crossings: [], stopsAt: [] };
    });
    return { now, weather, cars };
  }

  project(override = () => undefined) {
    const race = this.race, N = race.laps, S = this.start(), cars = S.cars;
    // Each car's crossings to its last lap; the flag falls when the first car completes lap N.
    for (const k of cars) {
      if (k.done) continue;
      let t = k.t;
      for (let lap = k.lap; lap <= N + 1; lap++) {
        // the stop at the end of this lap: decided already (this lap), or asked for
        let plan;
        if (lap === k.lap && (k.pitNow || k.inPit)) plan = k.pitNow ?? { litres: 0, tyres: false, swap: false, compound: k.compound, inProgress: true };
        else if (lap < N) {
          const o = override(k.i, lap, k);
          if (o !== undefined) plan = o;
          else {
            const env = S.weather.envAt(t - 5), car = this.stub(race.cars[k.i], k, lap);
            k.strat.env = env;
            try {
              plan = k.strat.decide(car, N - lap + 1, true, false);
              // The race re-plans the service at the box (Race.beginService): that plan is what the car gets.
              if (plan && !plan.penalty) plan = { ...plan, ...k.strat.servicePlan(car, Math.max(0, N - lap)) };
            } catch { plan = null; }
          }
        }
        k.crossings.push(t);
        if (lap >= N) break;
        // the next lap: stop loss (in- and out-lap together), then the lap itself on the state after the stop
        let add = 0;
        if (plan) {
          add += plan.inProgress ? 0 : this.stopCost(plan, k.damage); k.damage = 0;
          if (plan.tyres) { k.compound = plan.compound; k.wear = 0; k.stint = 0; }
          k.fuel = Math.min(TANK_LITRES, k.fuel + (plan.litres ?? 0)); k.stops += 1; if (plan.swap) k.swaps += 1;
          k.stopsAt.push({ lap, compound: plan.tyres ? plan.compound : null, litres: plan.litres ?? 0, swap: Boolean(plan.swap) });
          if (!plan.inProgress) { k.strat.stopDone?.(plan); }
        }
        const wet = S.weather.wet(t, t + this.pace.ref);
        const lapT = this.pace.lapTime(k.fit, k.compound, k.wear + k.wearRate(k.compound) / 2, Math.max(0, k.fuel - k.fuelPerLap / 2), wet);
        k.wear = Math.min(1, k.wear + k.wearRate(k.compound)); k.fuel = Math.max(0, k.fuel - k.fuelPerLap); k.stint += 1;
        k.strat.stintLaps = k.stint;
        t += lapT + add;
      }
    }
    return this.classify(S);
  }
  /** Car-shaped view of a projected state for a strategist copy's decide(). */
  stub(car, k, lap) {
    const wheels = car.wheels.map((w) => Object.assign(Object.create(w), { tyre: Object.assign(Object.create(w.tyre), { compound: k.compound, wear: k.wear }) }));
    return Object.assign(Object.create(car), { fuel: k.fuel, wheels, race: Object.assign(Object.create(car.race), { lap }) });
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
