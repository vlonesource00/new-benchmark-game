// INTERCEPT strategist v2 (STRATEGY-PLAN.md P2, first step): v1 plus full-information caution calls. Under a
// caution with the pit lane open it projects the race both ways (pit now / stay out) with the field projector and
// takes the better finishing place. Everything else is v1. Registered as 'v2' (setInterceptStrategy('v2')).
import { InterceptStrategist, registerInterceptStrategy } from './strategy.js';
import { FieldModel } from './race-model.js';

const models = new WeakMap();
const MARGIN = 2;                    // places a caution call must gain to overrule v1
/** One projector per race, shared by every v2 car in it (built on the first call). */
export function fieldModel(race) {
  let m = models.get(race);
  if (!m) { m = new FieldModel(race); models.set(race, m); }
  m.tracker.refresh();
  return m;
}

export class InterceptStrategist2 extends InterceptStrategist {
  constructor(previous, race, car) {
    super(previous, race.track.id, car.classId, race.lane);
    this.race = race; this.index = car.id; this.cautionCalls = [];
    // The projector learns every car's pace, fuel and wear from lap 1: build it at install (before the first lap),
    // not at the first caution, and re-wrap strategists other installers swap in later.
    try { fieldModel(race); } catch { /* race not fully built: the first lap retries */ }
  }
  observeLap(car, clean) {
    if (!this.__projected && this.race) { try { fieldModel(this.race); } catch { /* keep v1 */ } }
    return super.observeLap(car, clean);
  }
  decide(car, lapsLeft, aiDriving = true, caution = false) {
    const base = super.decide(car, lapsLeft, aiDriving, caution);
    // Hard calls stay v1's: a human request, fuel, the mandatory stop/swap, weather, a penalty or damage; copies
    // inside a projection are plain v1.
    if (!caution || !aiDriving || this.request || this.__projected || !this.race || lapsLeft <= 1) return base;
    if (base && /FUEL|MANDATORY|SWAP RULE|WEATHER|CALLED IN|PENALTY|DAMAGE|SERVE/.test(this.reason)) return base;
    let choice = null;
    try { choice = fieldModel(this.race).cautionChoice(this.index); } catch { choice = null; }
    if (!choice) return base;
    // Overrule v1 only on a clear margin: finishing places projected from here are within one place well under
    // nine times in ten (shadow-check), so a one-place edge is noise. Agreeing with v1 needs no margin.
    const pit = Boolean(base) === choice.worth ? choice.worth : choice.worth ? choice.gain >= MARGIN : -choice.gain >= MARGIN ? false : Boolean(base);
    this.cautionCalls.push({ lap: car.race.lap, base: Boolean(base), ...choice, pit_: pit });
    const tag = `${choice.kind.toUpperCase()} ${pit ? 'PIT' : 'STAY'}${pit !== choice.worth ? ' (HOLD)' : ''} P${choice.pit.place}/P${choice.stay.place}`;
    if (pit !== choice.worth) { this.reason = base ? `${this.reason} · ${tag}` : tag; return base; }
    if (choice.worth) {
      const plan = base ?? { ...this.servicePlan(car, Math.max(0, lapsLeft - 1)), tyres: true };
      if (!plan.compound) plan.compound = car.wheels[0].tyre.compound;
      this.plan = plan; this.boxThisLap = true; this.reason = tag;
      return plan;
    }
    this.plan = null; this.boxThisLap = false; this.reason = tag;
    return null;
  }
}

registerInterceptStrategy('v2', (prev, race, car) => new InterceptStrategist2(prev, race, car));
