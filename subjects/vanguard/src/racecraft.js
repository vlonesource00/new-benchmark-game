import { angle } from './math.js';

const ledgers = new WeakMap();
/** Observe the existing scalar damage assignments without changing their
 * value or the game's physics. This also sees damage while the pit pilot,
 * rather than the AI seat, owns controls. Snapshots still contain a number. */
export function damageSpent(car) {
  let ledger = ledgers.get(car);
  if (!ledger) {
    ledger = { value: car.damage ?? 0, total: car.damage ?? 0, race: car.race };
    const freshRace = () => { if (ledger.race !== car.race) { ledger.race = car.race; ledger.total = 0; } };
    Object.defineProperty(car, 'damage', { configurable: true, enumerable: true,
      get() { freshRace(); return ledger.value; },
      set(value) { freshRace(); ledger.total += Math.max(0, value - ledger.value); ledger.value = value; }
    });
    ledgers.set(car, ledger);
  }
  // Reading the accessor recognises a new race record before a new impact.
  void car.damage;
  return ledger.total;
}

/** The game's contact damage is closing normal speed * .003. A rub must be
 * aligned, lateral and gentle; accepting damage never makes a nose hit a rub. */
export function lightRubbing(a, b, contact) {
  return Boolean(contact && contact.longitudinal < 0.45 && contact.closing <= 2.5 &&
    contact.depth <= 0.32 && Math.abs(angle(a.h - b.h)) < 0.18);
}

export class Racecraft {
  constructor(options = {}) { this.options = options; this.reset(); }
  reset() {
    this.spent = 0; this.previousDamage = null; this.contactSpent = 0;
    this.lastTime = null; this.lastTouch = -Infinity; this.cooldownUntil = -Infinity; this.trace = {};
  }
  observe(car, state = {}) {
    if (Number.isFinite(state.time) && Number.isFinite(this.lastTime) && state.time < this.lastTime - 0.5) this.reset();
    this.lastTime = state.time ?? this.lastTime;
    const damage = Math.max(0, car.damage ?? 0);
    const now = state.time ?? 0, gained = this.previousDamage === null ? 0 : Math.max(0, damage - this.previousDamage);
    if (now - this.lastTouch > 2) this.contactSpent = 0;
    if (gained > 0) { this.contactSpent += gained; this.lastTouch = now; }
    if (this.previousDamage !== null) this.spent += gained;
    else this.spent = damage;
    if (Number.isFinite(state.damageSpent)) this.spent = state.damageSpent;
    else if (ledgers.has(car)) this.spent = damageSpent(car);
    this.previousDamage = damage;
    const laps = Math.max(1, state.totalLaps ?? 20), completed = Math.max(0, (car.race?.lap ?? 1) - 1);
    this.limit = (this.options.raceDamageBudget ?? 0.20) * Math.min(1, laps / 20);
    this.remaining = Math.max(0, this.limit - this.spent);
    this.moveBudget = Math.min(0.01, this.remaining / Math.max(1, laps - completed) * 1.5);
    if (gained > 0 && this.contactSpent >= this.moveBudget) this.cooldownUntil = now + 2;
    this.enabled = this.options.racecraft === true;
    this.rubbing = this.enabled && this.moveBudget >= 0.001 && now >= this.cooldownUntil;
    this.trace = { enabled: this.enabled, spent: this.spent, limit: this.limit,
      remaining: this.remaining, moveBudget: this.moveBudget, contactSpent: this.contactSpent,
      cooldown: Math.max(0, this.cooldownUntil - now), rubbing: this.rubbing };
  }
  clearance(normal, held = false) {
    return this.rubbing ? Math.min(normal, held
      ? (this.options.racingHoldSeparation ?? 2.08)
      : (this.options.racingSeparation ?? 2.20)) : normal;
  }
  routeMargin(normal, car, grip, wet) {
    return this.rubbing && grip > 0.95 && !wet && car.wheels.every(w => w.tyre.wear < 0.4) ? 1 : normal;
  }
  /** Keep force control at the door. Yield for a hard squeeze or a substantial
   * heading difference, not merely because an aligned car is close beside us. */
  canHold(car, r, room, lateralClosing) {
    return this.rubbing && !r.hazard && r.eligible && room > -0.12 &&
      room - Math.max(0, lateralClosing) * 0.30 > -0.18 && lateralClosing < 1.5 &&
      Math.abs(angle(car.yaw - r.car.yaw)) < 0.16;
  }
  contactRisk(a, b, contact, hazard, dt, previousPeak = 0) {
    if (!this.rubbing || hazard || !lightRubbing(a, b, contact)) return null;
    const damage = Math.max(0, contact.closing - previousPeak) * 0.003;
    return { damage, risk: dt * Math.max(0, contact.depth - 0.16) * 0.2 +
      damage / Math.max(0.001, this.moveBudget) * 0.08 };
  }
}
