import { tyreGrip } from '../../../game/engine/sim/tyre.js';
import { tyreWet } from '../../../game/engine/sim/water.js';
import { liveGrip } from '../../apex/src/model.js';

/** Sum the force available at each axle, rather than letting an unloaded
 * inside tyre stand in for both tyres. Keep the weaker axle as the vehicle
 * limit: stronger front tyres cannot conceal a degraded rear axle. */
export function forceWeightedGrip(car) {
  const live = [0, 0], reference = [0, 0], loaded = car.wheels.some(w => w.load > 100);
  car.wheels.forEach((wheel, i) => {
    const axle = i < 2 ? 0 : 1, tyre = wheel.tyre,
      load = loaded ? Math.max(100, Number.isFinite(wheel.load) ? wheel.load : 100) : 3300;
    live[axle] += tyreGrip(tyre, load) * load;
    reference[axle] += tyreGrip({ ...tyre, core: tyre.optimum ?? 90,
      pressure: 2.15, wear: 0, gripScale: 1 }, load) * load;
  });
  const front = live[0] / Math.max(1, reference[0]), rear = live[1] / Math.max(1, reference[1]);
  return { grip: Math.min(front, rear), front, rear, imbalance: front - rear };
}

export function forceWeightedCourseGrip(car) {
  // Solo grip headroom must not silently become a more aggressive tactical
  // envelope. Keep the established estimate in traffic, during returns and
  // before observations establish clear air. Both use the actual tyre formula.
  const clear = this.cleanAir === true;
  this.gripMode = clear ? 'axle-force-clear-air' : 'weakest-tyre-traffic';
  return (clear ? forceWeightedGrip(car).grip : liveGrip(car).grip) *
    (1 - .36 * tyreWet(this.track, car)) * (this.track.tempGrip ?? 1);
}
