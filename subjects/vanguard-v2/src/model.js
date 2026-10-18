import { CarModel } from '../../apex/src/model.js';
import { clamp } from './math.js';

/** Match the game's damage effects without changing the shared rival models.
 * Accepting bodywork damage must not leave our planner assuming fresh power
 * and drag. Lateral/downforce capacity is unchanged by damage in the game. */
export class VanguardModel extends CarModel {
  constructor(classId) {
    super(classId);
    this.baseDragK = this.dragK; this.baseDragN = this.dragN; this.damage = 0;
  }
  setDamage(damage = 0) {
    this.damage = clamp(damage, 0, 1);
    this.dragK = this.baseDragK * (1 + this.damage * 0.20);
    this.dragN = this.baseDragN * (1 + this.damage * 0.20);
  }
  engine(v, gear) { return super.engine(v, gear) * (1 - this.damage * 0.28); }
}
