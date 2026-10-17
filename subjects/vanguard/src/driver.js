import { Course, Route } from './course.js';
import { Observer } from './observer.js';
import { Controller, noseConstraint } from './controller.js';
import { Battle } from './battle.js';
import { Outcomes } from './outcomes.js';
import { Resources } from './strategy.js';
import { RivalMotion } from './motion.js';
import { PaceLearning } from './learning.js';
import { Racecraft, damageSpent } from './racecraft.js';
import { PitGuide } from '../../apex/src/pit.js';

/** VANGUARD driver: 120 Hz four-wheel force controller, S-thread traffic & fast hazard navigator, and co-state strategist. */
export class VanguardDriver {
  constructor(track, options = {}) {
    this.track = track;
    this.settings = options;
    this.options = options;
    this.prepared = false;
    this.epoch = 0;
    this.sequence = 0;
    this.lastPlan = -99;
  }
  prepare(car) {
    damageSpent(car);
    if (this.prepared && this.classId === car.classId) return;
    this.classId = car.classId;
    this.options = { ...this.settings, ...this.settings.classes?.[car.classId], ...this.settings.perClass?.[car.classId] };
    this.course = new Course(this.track, this.options);
    this.course.prepare(car);
    this.racecraft = this.course.racecraft = new Racecraft(this.options);
    this.observer = new Observer(this.track);
    this.observer.reference = this.course.line;
    if (this.options.motionForecast !== false) this.observer.motion = new RivalMotion(this.course, this.observer);
    this.controller = new Controller(this.options);
    this.course.controller = this.controller;
    this.learning = new PaceLearning(this.course, this.options);
    this.outcomes = new Outcomes();
    this.battle = new Battle(this.course, this.options, this.outcomes);
    this.resources = new Resources(this.options);
    this.pitGuide = new PitGuide(this.track);
    this.prepared = true;
  }
  reset() {
    this.epoch++;
    this.controller?.reset();
    this.observer?.reset();
    const book = this.lastCar?.race === this.raceRecord ? this.outcomes?.book : null;
    this.outcomes?.reset();
    if (book) this.outcomes.book = book;
    this.battle?.reset();
    this.pitGuide?.reset();
    this.learning?.reset();
    if (this.course?.line && (this.course.line.paceTrim.some(v => v !== 1) || this.course.line.brakeTrim.some(v => v !== 1))) {
      this.course.line.paceTrim.fill(1); this.course.line.brakeTrim.fill(1);
      this.course.rebuild = null;
      this.course.profileDirty = true; this.course.clock = 99;
    }
    this.remote = null;
    this.lastPlan = -99;
    this.accepted = -1;
  }
  adopt(contract, car, epoch) {
    if (!contract || contract.version !== 1 || contract.epoch !== epoch || contract.track !== this.track.id ||
        contract.classId !== car.classId || contract.sequence <= (this.accepted ?? -1)) return false;
    const keys = ['px', 'pz', 'h', 'ks', 'lat', 'vbrk', 'vmax', 'len', 'st'], n = contract.arrays?.px?.length;
    if (!(n >= 20 && n <= 300) || keys.some(k => contract.arrays[k]?.length !== n || contract.arrays[k].some(v => !Number.isFinite(v)))) return false;
    if (contract.arrays.len.some(v => v <= 0)) return false;
    this.prepare(car);
    this.remote = new Route(contract);
    this.accepted = contract.sequence;
    this.battle.adopt(contract.battle);
    const target = this.observer.list.find(r => r.id === contract.battle?.target);
    if (target?.eligible && contract.battle.side && ['ATTACK', 'ALONGSIDE'].includes(contract.battle.state)) {
      this.outcomes.declare(target, this.observer, contract.time, contract.battle.side);
    }
    return true;
  }
  update(car, cars, dt, context = {}) {
    this.lastCar = car;
    this.contextEpoch = context.epoch ?? 0;
    this.prepare(car);
    const now = context.time ?? 0,
      state = (this.state = { ...(context.state ?? {}), time: now, totalLaps: context.state?.totalLaps ?? context.totalLaps });
    if (Number.isFinite(this.lastTime) && now < this.lastTime - 0.5) this.outcomes.reset();
    this.raceRecord = car.race;
    this.racecraft.observe(car, state);
    this.observer.update(car, cars, state, now);
    const allowance = this.resources.update(car, state, this.observer, dt);
    this.course.cleanAir = this.battle.state === 'PACE' && !state.formation &&
      !this.observer.list.some(r => r.physical && !r.pit && Math.abs(r.ds) < 85);
    this.course.tick(car, dt, allowance);
    this.course.setDelay(car, context.controlDelay, context.feedbackPeriod, this.path);
    this.course.controlMemory = state.controlMemory;
    const pit = Boolean(car.race?.boxThisLap || state.pitPlan) && (!state.pit || state.pit === 'approach'),
      toPit = pit ? this.pitGuide.toEntry(this.observer.me.s) : Infinity;
    let path = this.course.line, pitCap = Infinity;
    if (toPit < 600 && toPit > 0.3) {
      path = this.pitGuide.path ?? this.pitGuide.build(this.course.line, this.course.model, {
        mass: car.spec.mass + car.fuel * 0.75, brakeExp: this.course.brakeExponent(car)
      });
      pitCap = this.pitGuide.cap(toPit);
      this.battle.state = 'PIT';
    } else {
      if (this.pitGuide.path) this.pitGuide.reset();
      const active = !state.formation && state.phase !== 'grid' && state.phase !== 'countdown' && state.session !== 'qualifying';
      if (this.options.combat === false) {
        this.battle.reset();
        this.remote = null;
      } else if (this.settings.executor) {
        this.battle.progress(this.observer, now);
        if (this.remote?.valid(car, this.track)) path = this.remote;
        else this.remote = null;
        const nc = noseConstraint(car, this.observer, this.course.model);
        if (active && nc.blocker?.hazard && nc.blocker.ds < Math.max(26, car.speed * 0.85)) {
          path = this.battle.update(car, this.observer, now, { force: now - this.battle.at > 0.12, enabled: true });
        }
      } else if (active) {
        path = this.battle.update(car, this.observer, now);
      }
      if (!active) {
        this.battle.state = 'PACE';
        this.remote = null;
      }
    }
    this.path = path;
    this.controller.step(car, path, this.course, this.observer, Number.isFinite(dt) && dt > 0 ? Math.min(0.1, dt) : 1 / 120, {
      pit: pitCap,
      time: now,
      returning: this.battle.state === 'RETURN',
      brakingTube: this.options.brakingTube && !state.formation && state.phase !== 'grid' && state.phase !== 'countdown'
    });
    this.resources.energy(car, state, this.battle, path, this.controller, this.observer);
    if (!this.settings.executor) this.learning.sample(car, path, this.observer, this.controller, dt, state);
    this.outcomes.update(car, this.observer, now, this.battle);
    this.sequence++;
    this.lastTime = now;
    return car.controls;
  }
  preview(epoch = 0) {
    return this.path ? this.course.contract(this.path, this.observerCar ?? this.lastCar, this.battle.wire(), this.lastTime, epoch, this.sequence) : null;
  }
  controlPreview() {
    return this.course.contract(this.path, this.lastCar, this.battle.wire(), this.lastTime, this.contextEpoch ?? 0, this.sequence);
  }
  debug() {
    const r = this.observer?.list.find(r => r.id === this.battle?.target), c = this.controller;
    return {
      architecture: 'VANGUARD',
      intent: this.battle?.state ?? 'INIT',
      returnReason: this.battle?.returnReason ?? null,
      maneuver: this.battle?.moveKind ?? null,
      mode: c?.mode,
      targetSpeed: c?.targetSpeed,
      lineSpeed: c?.lineSpeed,
      e: c?.e,
      focus: r?.id ?? null,
      focusGap: r?.ds ?? null,
      side: this.battle?.side ?? 0,
      returnNeighbor: this.battle?.returnTarget ?? null,
      planAge: this.remote ? Math.max(0, this.lastTime - this.remote.contract.time) : 0,
      trace: c?.trace,
      resources: this.resources?.trace,
      racecraft: this.racecraft?.trace,
      paceLearning: this.learning?.debug(),
      surface: this.course?.surface,
      wetLine: this.course?.surfaceChoice,
      stats: this.outcomes?.book,
      events: this.outcomes?.events,
      route: {
        key: this.path?.key ?? 'course',
        sequence: this.remote?.contract.sequence ?? this.sequence,
        epoch: this.contextEpoch,
        sourceS: this.remote?.contract.sourceS,
        endS: this.remote?.contract.endS
      },
      observed: this.observer?.list.slice(0, 6).map(q => ({
        id: q.id, kind: q.kind, s: q.s, gap: q.ds, lateral: q.d, speed: q.v,
        closing: (this.lastCar?.speed ?? 0) - q.v, acceleration: q.ax, bodyDeceleration: q.deceleration,
        lateralSpeed: q.vd, headingError: q.psi, eligible: q.eligible, physical: q.physical,
        hazard: q.hazard, pit: q.pit, boxing: q.approaching, offroad: q.off, reenter: q.reenter,
        forecast: [0.5, 1.5].map(t => ({ t, ...this.observer.at(q, t) }))
      })),
      cands: this.battle?.candidates.map(q => ({
        kind: q.kind, key: q.path?.key ?? 'course', side: q.side, score: q.score,
        progress: q.progress, exit: q.exit, risk: q.risk, blocked: q.blocked,
        rubbingDamage: q.rubbingDamage,
        hardImpact: q.hardImpact, preparation: q.preparation,
        relativeGain: q.relativeGain, exitAdvantage: q.exitAdvantage,
        plant: q.plant, trackable: q.trackable, maxError: q.maxError, offtrack: q.offtrack,
        horizon: q.horizon, clearSeconds: q.clearSeconds, validForecast: q.validForecast,
        returnChecked: q.returnChecked,
        routeTax: q.routeTax, profileFloor: q.path?.profileFloor, clear: q.cleared,
        finalGap: q.finalGap, fits: q.fits, chosen: q.path === this.path
      })),
      sub: r ? `${this.battle.state.toLowerCase()} #${r.id} ${r.ds.toFixed(1)} m` : (c?.mode?.toLowerCase() ?? 'priming')
    };
  }
  visualDebug() {
    const p = this.path, c = this.controller?.cur;
    if (!p || !c) return null;
    const pts = [];
    for (let x = 0; x < Math.min(260, Math.max(90, this.lastCar.speed * 4)); x += 8) {
      pts.push({ x: p.sample(p.px, c.i, c.f, x), z: p.sample(p.pz, c.i, c.f, x), v: p.sample(p.vbrk, c.i, c.f, x) });
    }
    return {
      trackingPoint: pts[2],
      selectedTrajectory: { points: pts, mode: this.battle.state, color: '#00f5d4' },
      extras: { side: this.battle.side, target: this.battle.target }
    };
  }
}
