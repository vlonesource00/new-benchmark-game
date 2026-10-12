import { toControls, clamp } from './schema.mjs';

// Hidden state is committed with the accepted action, never with a late reply.
export class ActionMailbox {
  constructor({ deadline = .1, hiddenSize = 128, actionSize = 2 } = {}) {
    if (![2, 4].includes(actionSize)) throw Error('Unknown action width');
    this.deadline = deadline; this.hiddenSize = hiddenSize; this.actionSize = actionSize; this.reset();
  }
  reset() { this.epoch = (this.epoch ?? 0) + 1; this.seq = 0; this.accepted = 0; this.at = 0; this.action = new Array(this.actionSize).fill(0); this.hidden = new Array(this.hiddenSize).fill(0); this.stats = { accepted: 0, late: 0, obsolete: 0, invalid: 0 }; }
  request(now) { return { epoch: this.epoch, seq: ++this.seq, base: this.accepted, at: now, hidden: [...this.hidden] }; }
  accept(reply, now) {
    if (reply.epoch !== this.epoch || reply.seq <= this.accepted || reply.base !== this.accepted) { this.stats.obsolete++; return false; }
    if (now - reply.at > this.deadline + 1e-9 || reply.at > now + 1e-9) { this.stats.late++; return false; }
    if (reply.action?.length !== this.actionSize || reply.hidden?.length !== this.hiddenSize || ![...reply.action, ...reply.hidden].every(Number.isFinite)
      || (reply.correction !== undefined && (reply.correction?.length !== 2 || !Array.from(reply.correction).every(Number.isFinite)))) { this.stats.invalid++; return false; }
    this.action = reply.action.map(x => clamp(x, -1, 1)); this.hidden = [...reply.hidden]; this.at = reply.at; this.accepted = reply.seq; this.stats.accepted++;
    return true;
  }
}

export function supervise(action, race, car) {
  const reasons = [];
  if (action.length !== 2 || !action.every(Number.isFinite)) return { controls: { steer: 0, throttle: 0, brake: .6 }, reasons: ['non-finite'] };
  const controls = toControls(action);
  // Fresh body-space obstruction, not speculative overlap of future racing paths.
  for (const other of race.cars) {
    // Match the current plant: its collision solver ignores a pair only when
    // both bodies are ghosted. A sensor-ineligible car can still block the nose.
    if (other === car || (car.ghost && other.ghost)) continue;
    const dx = other.x - car.x, dz = other.z - car.z, right = dx * Math.cos(car.yaw) - dz * Math.sin(car.yaw), forward = dx * Math.sin(car.yaw) + dz * Math.cos(car.yaw);
    const yaw = other.yaw - car.yaw, width = .98 + Math.abs(Math.cos(yaw)) * .98 + Math.abs(Math.sin(yaw)) * 2.28;
    const front = 2.28 + Math.abs(Math.cos(yaw)) * 2.28 + Math.abs(Math.sin(yaw)) * .98;
    const closing = (car.vx - other.vx) * Math.sin(car.yaw) + (car.vz - other.vz) * Math.cos(car.yaw);
    const room = forward - front;
    // A thin, aligned side brush at matched speed is permitted. Stopped/spun
    // bodies and severe closing speed never get this allowance.
    const thinBrush = Math.abs(right) >= width - .3 && closing <= 6 && Math.abs(Math.atan2(Math.sin(yaw), Math.cos(yaw))) < .2;
    if (thinBrush) continue;
    if (forward > front * .65 && Math.abs(right) < width + .08 && closing > 1 && room < closing * .12 + closing * closing / 24) {
      const brake = clamp(closing * closing / Math.max(1, 24 * Math.max(.2, room - closing * .1)), 0, 1);
      controls.throttle = 0; controls.brake = Math.max(controls.brake, brake); reasons.push(`front-blocked:${other.id}`);
    }
  }
  return { controls, reasons };
}

export function timing(values) {
  const a = [...values].sort((x, y) => x - y), q = p => a.length ? a[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)] : null;
  return { count: a.length, p50: q(.5), p95: q(.95), p99: q(.99), max: a.at(-1) ?? null };
}
