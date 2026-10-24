// The follow rule: the speed a car may carry toward the car ahead of it in its path and still stop behind it.
// One rule for everyone the planner simulates (rivals always follow, COUNTERPOINT only when its plan says so), and
// the live car uses the same function, so a "follow" plan is driven as it was forecast.
import { wrap } from '../../../game/engine/sim/math.js';

const LEN = 4.56, WIDE = 2.15;

/** Track-frame gap from a to b (metres along the road, + ahead) and lateral offset (b right of a). */
export function relative(a, b, length) {
  return { ds: wrap(b.s - a.s + length / 2, length) - length / 2, dl: b.lateral - a.lateral };
}

/** Cap for `me` behind the nearest car in its lane, or Infinity. `decel` is the braking it may plan on. */
export function followCap(me, cars, length, { decel = 9, react = 0.15, reach = 70, skip = null } = {}) {
  let cap = Infinity;
  for (const o of cars) {
    if (o === me || o === skip || o.ghost) continue;
    const { ds, dl } = relative(me, o, length);
    if (ds <= 0 || ds > reach || Math.abs(dl) > WIDE) continue;
    const room = Math.max(0, ds - LEN - me.speed * react - 0.5), vo = Math.max(0, o.speed);
    cap = Math.min(cap, Math.sqrt(vo * vo + 2 * decel * room));
  }
  return cap;
}
