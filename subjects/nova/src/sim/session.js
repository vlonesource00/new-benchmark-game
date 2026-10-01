// DeepSeek Session
// Race/session framework inherited from the Astra foundation and rewired to the
// DeepSeek driver stack. AI cars and the human car are the same Vehicle objects
// with the same physics, wake model and collision model.

import { Vehicle, wakes, collisions } from './vehicle.js';
import { wrap, clamp } from './math.js';
import { raceInterval } from './interval.js';
import { halfCarInside } from '../core/rules.js';
import { CLASS_IDS, carSpecFor } from './car-specs.js';
import { buildTrackModel } from '../tracks/track-model.js';
import { createEnvelope } from '../ai/global/envelope.js';
import { makeBasis, insideSeedCoeffs, repair } from '../ai/global/line-optimizer.js';
import { RaceLine } from '../ai/race-line.js';
import { DeepSeekAI } from '../ai/driver.js';
import { NativeDriver } from './native-adapter.js';
import { NovaDriver } from '../ai/nova/index.js';
import { NOVA_FREE_AIR } from '../tracks/lines/harbor-ring-nova.js';
import { installNovaHud } from '../render/nova-hud.js';
import { bakedLines } from '../tracks/lines/index.js';

export function makeNovaReferenceFromLine(line) {
  if (!line || !line.path || !line.profile) return null;
  const model = line.model;
  const n = line.path.n;
  const ds = model.ds;
  const length = model.length;
  return {
    track: model.id,
    kind: 'race-line-nova',
    n,
    ds,
    length,
    halfWidth: model.halfWidth,
    speedScale: 1.0,
    referenceTime: line.time,
    q: line.q,
    v: line.profile.v,
    kappa: line.path.kappa,
    heading: line.path.heading,
    x: line.path.px,
    z: line.path.pz,
  };
}

const GRID = [['YOU', '#df482d'], ['M. ROSSI', '#d4dbd9'], ['J. MOREAU', '#356653'], ['A. WEBER', '#d7a32e'], ['K. SATO', '#2e515f'], ['L. COSTA', '#a0a399'], ['O. REED', '#4058a0'], ['S. LAURENT', '#d5c6a8']];

export class Session {
  constructor(track, { classId = 'gt', mixed = false } = {}) {
    this.track = track;
    this.classId = carSpecFor(classId).key;
    this.mixed = mixed;
    this.model = buildTrackModel(track, { spacing: 0.5 });
    this.envelopes = new Map();
    this.lines = new Map();
    this.cars = GRID.map(([name, color], id) => new Vehicle(id, name, color, mixed ? CLASS_IDS[(id + CLASS_IDS.indexOf(this.classId)) % CLASS_IDS.length] : this.classId));
    this.lineFor = (car) => this.lineForClass(car.classId);
    this.line = this.lineFor(this.cars[0]);
    this.aggression = 0.72;
    this.paceObjective = 'race';
    this.aiOptions = {};
    this.drivers = this.cars.map((c) => this.makeDriver(c));
    this.player = this.cars[0];
    this.mode = 'race';
    this.laps = 3;
    this.field = 6;
    this.phase = 'menu';
    this.time = 0;
    this.countdown = 0;
    // NOVA FLYING HOTLAP (user testing mode, not a standing-start benchmark):
    //   ?nova=1&spawn=400&novaScale=1.0&hud=1
    // One car, NOVAFreeAirController in strict mode, no legacy fallback, no
    // countdown, spawned on the NOVA reference 300-500 m before the timing line.
    if (typeof window !== 'undefined') {
      const qs = new URLSearchParams(window.location.search);
      const lineVariant = qs.get('line') ?? qs.get('variant') ?? 'measured';
      this.aiOptions = { ...this.aiOptions, lineVariant };
      this.line = this.lineForClass(this.classId);
      if (/(?:^|[?&])nova=1/.test(window.location.search)) {
        this.novaFlying = {
          spawnMeters: Number(qs.get('spawn') ?? 400),
          speedScale: Number(qs.get('novaScale') ?? 1.0),
          reference: makeNovaReferenceFromLine(this.line) || NOVA_FREE_AIR,
          hud: qs.get('hud') !== '0',
        };
        this.aiKind = 'nova';
        this.aiOptions = { ...this.aiOptions, novaSpeedScale: this.novaFlying.speedScale, strict: true, trace: true };
      }
    }
    this.contacts = 0;
    this.autopilot = false;
    this.reset();
  }

  envelopeFor(classId) {
    const spec = carSpecFor(classId);
    if (!this.envelopes.has(spec.key)) {
      const bakedMeasured = bakedLines[`${this.track.id}-${spec.key}-measured`];
      const curves = this.aiOptions?.curves ?? bakedMeasured?.curves ?? null;
      this.envelopes.set(spec.key, createEnvelope(spec, {
        surfaceGrip: 1, fuelKg: 20, wing: 6,
        curves,
        calibration: this.calibration?.get?.(spec.key) ?? this.calibration ?? {},
      }));
    }
    return this.envelopes.get(spec.key);
  }

  lineForClass(classId) {
    const spec = carSpecFor(classId);
    const variant = this.aiOptions?.lineVariant ? `-${this.aiOptions.lineVariant}` : '';
    const lineKey = `${spec.key}${variant}`;
    if (this.lines.has(lineKey)) return this.lines.get(lineKey);
    const baked = bakedLines[`${this.track.id}-${spec.key}${variant}`] || bakedLines[`${this.track.id}-${spec.key}`];
    const envelope = baked?.curves
      ? createEnvelope(spec, { surfaceGrip: 1, fuelKg: 20, wing: 6, curves: baked.curves, calibration: this.calibration?.get?.(spec.key) ?? this.calibration ?? {} })
      : this.envelopeFor(spec.key);
    let line;
    if (baked) {
      line = new RaceLine(this.model, envelope, { widths: baked.widths, overlap: baked.overlap ?? 2, coeffs: baked.coeffs, meta: baked });
    } else {
      // No baked line for this track/class. The full optimiser takes minutes of
      // CPU, so it must never run on the render thread (it freezes the tab and
      // the browser kills the page). Fall back to the analytic inside seed,
      // which is O(n) and always inside the legal corridor; pace here is
      // deliberately sacrificed for the ability to open the page at all.
      console.warn(`[DeepSeek] no baked line for ${this.track.id}-${spec.key}; using analytic seed line`);
      const widths = [96, 48, 24];
      const basis = makeBasis(this.model, { widths, overlap: 4 });
      const q = new Float64Array(this.model.n);
      const coeffs = repair(this.model, basis, insideSeedCoeffs(this.model, basis, { factor: 0.85, shift: 16 }), q);
      line = new RaceLine(this.model, envelope, { widths, overlap: 4, coeffs, meta: { runtime: 'seed' } });
    }
    this.lines.set(lineKey, line);
    return line;
  }

  makeDriver(car) {
    const line = this.lineFor(car);
    
    let kind = this.aiKind;
    if (typeof window !== 'undefined' && window.location.search) {
      const qs = new URLSearchParams(window.location.search);
      if (qs.has('ai')) kind = qs.get('ai');
    }

    // LEGACY_BASELINE stays intact; NOVA is the live controller and
    // uses the legacy stack only as its own fallback.
    const legacy = new DeepSeekAI({ model: this.model, envelope: line.envelope, line, options: this.aiOptions });
    if (kind === 'legacy') return new NativeDriver(legacy);
    
    const reference = makeNovaReferenceFromLine(line) || NOVA_FREE_AIR;
    if (reference && reference.n && (kind === 'nova' || kind === 'nova-proxy' || !kind || kind === 'nova-flying')) {
      // 'nova' currently defaults to 'nova-proxy' until M_RT and NMPC are integrated
      const nova = new NovaDriver({
        reference,
        envelope: line.envelope,
        model: this.model,
        line,
        fallback: legacy,
        options: {
          ...this.aiOptions,
          speedScale: this.aiOptions?.novaSpeedScale ?? 1,
          strict: Boolean(this.aiOptions?.strict),
          trace: Boolean(this.aiOptions?.trace),
        },
      });
      if (this.aiOptions?.verboseAi) console.log(`[driver] NOVA driver (n=${reference.n}, scale=${this.aiOptions?.novaSpeedScale ?? 1})`);
      if (this.novaFlying?.hud && !this.novaHudInstalled) {
        this.novaHudInstalled = true;
        const session = this;
        installNovaHud(() => {
          // Resolve live objects each frame: the session replaces cars and
          // drivers on start(), so a captured reference would show stale zeros.
          const a = session.drivers?.[0]?.ai ?? nova;
          const car = session.cars?.[0];
          const active = (a.novaTime ?? 0) + (a.legacyTime ?? 0);
          return {
            phase: session.phase,
            novaControlPct: active > 0 ? 100 * (a.novaTime ?? 0) / active : 0,
            legacyControlTime: a.legacyTime ?? 0,
            fallbackCount: a.fallbackCount ?? 0,
            strictFailure: a.strictFail ? 1 : 0,
            strictFailureDetail: a.strictFail,
            lapTime: car?.race?.lastLap ?? null,
            lapValid: car?.race?.valid === true ? 'yes' : 'no',
            speed: car?.speed, target: a?.state?.targetSpeed,
            targetLimit: a?.state?.targetLimitReason,
            throttleLimit: a?.state?.throttleLimitReason,
            brakeReason: a?.state?.brakeReason,
            brakeMargin: a?.state?.brakingMarginMeters,
            qErr: a?.state?.elat, hErr: a?.state?.ehead, yawRate: car?.yawRate,
            slip: car?.beta ?? 0, steer: a?.state?.steer, throttle: a?.state?.throttle, brake: a?.state?.brake,
          };
        });
      }
      return new NativeDriver(nova);
    }
    if (this.aiOptions?.verboseAi) console.log('[driver] LEGACY baseline (no nova reference)');
    return new NativeDriver(legacy);
  }

  get activeCars() { return this.cars.slice(0, this.mode === 'practice' ? 1 : this.field); }

  reset() {
    this.time = 0;
    this.contacts = 0;
    this.results = null;
    this.collisionStats = { peakClosing: 0, severeContacts: 0 };
    this.cars.forEach((c, i) => {
      const start = this.track.scenario?.start, rowSpacing = start?.rowSpacingM ?? 9.5, lane = start?.laneOffsetM ?? 2.3;
      const ref = this.novaFlying?.reference;
      if (ref && i === 0) {
        const s0 = wrap(this.track.finishS - this.novaFlying.spawnMeters, this.track.length);
        const k = Math.max(0, Math.min(ref.n - 1, Math.round(s0 / ref.ds)));
        const v0 = Math.max(5, (ref.v[k] ?? 25) * this.novaFlying.speedScale);
        c.place(this.track, s0, ref.q[k], v0);
        c.yaw = ref.heading[k];
        try { c.yawRate = v0 * ref.kappa[k]; } catch { /* derived field */ }
      } else {
        c.place(this.track, this.track.gridS - Math.floor(i / 2) * rowSpacing, i % 2 ? -lane : lane);
      }
      this.drivers[i] = this.makeDriver(c);
      const gridToFinish = wrap(this.track.finishS - this.track.gridS, this.track.length);
      c.race = { progress: -gridToFinish - Math.floor(i / 2) * rowSpacing, previousS: c.s, lap: 1, lastLap: null, bestLap: null, lapStart: 0, sector: 0, valid: true, sectors: [], finishTime: null, offtrack: 0 };
    });
    this.timingHistory = this.cars.map((c) => [{ progress: c.race.progress, time: 0 }]);
    this.nextTimingAt = 0;
  }

  start({ freshTrack = false } = {}) {
    if (freshTrack) this.track.rubber.fill(0);
    this.reset();
    if (this.novaFlying) { this.phase = 'racing'; this.countdown = 0; return; }
    this.phase = 'countdown';
    this.countdown = 4;
  }

  step(dt, playerControls) {
    if (!['racing', 'countdown'].includes(this.phase)) return;
    if (this.phase === 'countdown') { this.countdown -= dt; if (this.countdown <= 0) this.phase = 'racing'; return; }
    this.time += dt;
    const cars = this.activeCars;
    const projections = new Map(cars.map((c) => [c.id, this.track.nearest(c.x, c.z)]));
    const order = [...cars].sort((a, b) => (a.race.finishTime ?? Infinity) - (b.race.finishTime ?? Infinity) || b.race.progress - a.race.progress);
    const position = new Map(order.map((c, i) => [c.id, i + 1]));
    const context = { track: this.track, projections, order, totalLaps: this.laps, mode: this.mode, time: this.time, paceObjective: this.paceObjective, position: position.get(cars[0].id) };
    cars.forEach((c, i) => {
      if (i === 0 && !this.autopilot) c.controls = playerControls;
      else {
        context.position = position.get(c.id);
        this.drivers[i].update(c, cars, dt, context);
      }
      if (c.race.finishTime !== null) c.controls = { ...c.controls, throttle: Math.min(0.35, c.controls.throttle), brake: Math.max(c.controls.brake, c.speed > 25 ? 0.2 : 0) };
    });
    const airflow = wakes(cars);
    cars.forEach((c, i) => c.step(dt, this.track, airflow[i]));
    this.contacts += collisions(cars, this.collisionStats);
    for (const c of cars) {
      const r = c.race;
      const previousProgress = r.progress;
      const delta = wrap(c.s - r.previousS + this.track.length / 2, this.track.length) - this.track.length / 2;
      r.previousS = c.s;
      if (Math.abs(delta) < 20) r.progress += delta;
      if (this.track.scenario && previousProgress < 0 && r.progress >= 0) { r.lapStart = this.time; r.valid = true; }
      if (!halfCarInside(c.lateral, this.track.halfWidth)) { r.valid = false; r.offtrack += dt; }
      const totalSectors = Math.floor(Math.max(0, r.progress) / (this.track.length / 3));
      if (totalSectors > r.sector) {
        r.sectors.push(this.time);
        r.sector = totalSectors;
        if (totalSectors % 3 === 0) {
          r.lastLap = this.time - r.lapStart;
          if (r.valid && (r.bestLap === null || r.lastLap < r.bestLap)) r.bestLap = r.lastLap;
          r.lapStart = this.time;
          r.lap++;
          r.valid = true;
          if (this.mode !== 'practice' && r.lap > this.laps && r.finishTime === null) r.finishTime = this.time;
        }
      }
    }
    if (this.time >= this.nextTimingAt) {
      this.nextTimingAt = this.time + 0.25;
      for (const c of cars) {
        const h = this.timingHistory[c.id];
        if (c.race.progress > h.at(-1).progress) { h.push({ progress: c.race.progress, time: this.time }); if (h.length > 2400) h.shift(); }
      }
    }
    if (this.player.race.finishTime !== null) { this.phase = 'finished'; this.results = this.standings(); }
  }

  interval(car, leader = this.standings()[0]) {
    if (car === leader) return 0;
    if (car.race.finishTime !== null && leader.race.finishTime !== null) return car.race.finishTime - leader.race.finishTime;
    return raceInterval(this.timingHistory[leader.id], car.race.progress, this.time, leader.race.progress);
  }

  standings() {
    return [...this.activeCars].sort((a, b) => (a.race.finishTime ?? Infinity) - (b.race.finishTime ?? Infinity) || b.race.progress - a.race.progress);
  }

  recover() {
    const c = this.player, saved = { ...c.race }, fuel = c.fuel, damage = c.damage;
    c.place(this.track, c.s, 0, 0);
    c.race = saved;
    c.race.previousS = c.s;
    c.race.valid = false;
    c.fuel = fuel;
    c.damage = damage;
    this.time += 5;
  }
}

export { clamp };

