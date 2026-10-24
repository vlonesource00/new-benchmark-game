import { VanguardDriver } from '../../vanguard-v2/src/driver.js';
import { CounterpointBattle } from './battle.js';
import { CounterpointController } from './controller.js';
import { refineCorridor } from './corridor.js';
import { forceWeightedCourseGrip } from './grip.js';

/** Counterpoint extends VANGUARD's physical controller and tactical protocol. */
export class CounterpointDriver extends VanguardDriver {
  reset() {
    super.reset();
    this.battle?.resetEpisode();
  }

  prepare(car) {
    const wasPrepared = this.prepared, previousClass = this.classId,
      initializationNeeded = !wasPrepared || previousClass !== car.classId;
    super.prepare(car);
    if (!initializationNeeded || !this.prepared || this.classId !== car.classId) return;

    this.battle = new CounterpointBattle(this.course, this.options, this.outcomes);
    if (this.options.interactive !== false) {
      if (this.options.refineCorridors !== false) this.course.refineCorridor = refineCorridor;
      if (this.options.forceWeightedGrip === true) {
        this.course.grip = forceWeightedCourseGrip;
        this.course.refresh(car, true);
      }
      this.controller = new CounterpointController(this.options);
      this.course.controller = this.controller;
      // Course uses this pool for route arrays. Keep Vanguard's tactical
      // candidate cap unchanged so interactive:false remains the base ablation.
      while (this.course.pool.length < 16) {
        const path = this.course.line.blankLane();
        path.st = this.course.line.st.slice();
        this.course.pool.push({ path, window: null });
      }
    }
  }

  debug() {
    const result = super.debug();
    result.architecture = 'COUNTERPOINT';
    result.configuration = { stagedAttacks: this.options?.stagedAttacks === true, setupAttacks: this.options?.setupAttacks === true,
      setupMinClosing: this.options?.setupMinClosing ?? 0,
      maxMoveDamageBudget: this.options?.maxMoveDamageBudget ?? .01,
      raceBudgetFrontload: this.options?.raceBudgetFrontload ?? 0, doorOverlap: this.options?.doorOverlap ?? .14,
      commitWindow: this.options?.commitWindow ?? 0, coastRecovery: this.options?.coastRecovery === true,
      forceWeightedGrip: this.options?.forceWeightedGrip === true, refineCorridors: this.options?.refineCorridors !== false };
    result.interactive = this.battle?.debugStats?.() ?? {
      enabled: this.options?.interactive !== false, decisions: 0, workCount: 0, branchCount: 0, candidates: []
    };
    return result;
  }
}
