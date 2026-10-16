import { clamp } from './math.js';

/** Online station trims for the existing physical pace model. Only genuine
 * clean-air, on-line observations can teach the clean-air speed profile. */
export class PaceLearning {
  constructor(course, options) {
    this.course = course; this.options = options;
    this.peaks = new Float32Array(course.line.N);
    this.reset();
  }
  reset() {
    this.peaks.fill(0); this.lap = null; this.clean = false; this.cleanLaps = 0;
    this.changed = 0; this.slides = 0; this.skipped = 0; this.slideAt = -Infinity;
    this.compound = null; this.lastDamage = 0;
  }
  sample(car, path, observer, control, dt, state) {
    if (this.options.learn === false) return;
    const line = this.course.line, lap = car.race?.lap ?? 1, compound = car.wheels[0].tyre.compound;
    const dirty = (car.aero?.wake ?? 0) > 0.03 || observer.list.some(r => r.physical && !r.pit && Math.abs(r.ds) < 65);
    const onLine = path === line && Math.abs(control.e ?? Infinity) < 0.45;
    const valid = onLine && !dirty && !state.formation && state.phase !== 'countdown' &&
      Math.abs(car.lateral) < observer.track.halfWidth + observer.track.curbWidth &&
      car.damage <= this.lastDamage + 1e-8 && car.speed > 12;
    if (this.compound !== compound) {
      const changed = this.compound !== null;
      this.compound = compound; this.peaks.fill(0); this.clean = false; this.cleanLaps = 0;
      if (changed) { line.paceTrim.fill(1); line.brakeTrim.fill(1); this.course.profileDirty = true; }
    }
    if (this.lap !== null && lap !== this.lap) {
      if (lap === this.lap + 1 && this.clean && !['red', 'pit'].includes(car.race?.lastState)) {
        this.cleanLaps++;
        if (this.cleanLaps >= 2) {
          const target = this.options.slipTarget ?? 2.0, gain = this.options.learnGain ?? 0.1;
          for (let i = 0; i < line.N; i++) {
            if (this.peaks[i] < 0.3 || line.vmax[i] > line.v[i] + 0.6) continue;
            const next = clamp(line.paceTrim[i] * (1 + gain * clamp((target - this.peaks[i]) / target, -0.12, 0.06)), 0.85, 1.04);
            if (Math.abs(next - line.paceTrim[i]) > 1e-8) this.changed++;
            line.paceTrim[i] = next;
          }
          this.course.profileDirty = true;
        }
      }
      this.peaks.fill(0); this.clean = true;
    }
    if (this.lap === null) this.clean = false; // The first partial lap is never training evidence.
    this.lap = lap; this.lastDamage = car.damage;
    if (!valid) { this.clean = false; this.skipped++; return; }
    const i = control.cur.i;
    let slip = 0;
    for (const w of car.wheels) slip = Math.max(slip, Math.tan(Math.min(1.2, Math.abs(w.tyre.alpha))) * 8.6);
    const radius = Math.min(3, Math.ceil(car.speed * Math.min(0.1, dt) / line.ds * 0.5));
    for (let j = -radius; j <= radius; j++) {
      const k = line.idx(i + j); this.peaks[k] = Math.max(this.peaks[k], slip);
    }
    if (control.trace.reserve < 0.5 && state.time - this.slideAt > 1.5) {
      this.slideAt = state.time; this.slides++;
      for (let j = -Math.ceil(60 / line.ds); j <= 4; j++) {
        const k = line.idx(i + j); line.brakeTrim[k] = Math.max(0.85, line.brakeTrim[k] * 0.97);
      }
      for (let j = -4; j <= 8; j++) {
        const k = line.idx(i + j); line.paceTrim[k] = Math.max(0.85, line.paceTrim[k] * 0.985);
      }
      this.course.profileDirty = true;
    }
  }
  debug() { return { cleanLaps: this.cleanLaps, adjustedStations: this.changed, slides: this.slides, rejectedSamples: this.skipped }; }
}
