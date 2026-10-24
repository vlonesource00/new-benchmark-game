// The follow rule: the speed a car may carry toward the car ahead of it in its path and still stop behind it.
// One rule for everyone the planner simulates (rivals always follow, COUNTERPOINT only when its plan says so), and
// the live car uses the same function, so a "follow" plan is driven as it was forecast.
import { wrap } from '../../../game/engine/sim/math.js';
import { envelope, at } from '../../oracle/src/envelope.js';
import { downforceShare } from '../../oracle/src/combat.js';

const LEN = 4.56, WIDE = 2.15;

/** Track-frame gap from a to b (metres along the road, + ahead) and lateral offset (b right of a). */
export function relative(a, b, length) {
  return { ds: wrap(b.s - a.s + length / 2, length) - length / 2, dl: b.lateral - a.lateral };
}

/**
 * Cap for `me` behind the nearest car in its lane, or Infinity: both cars brake as hard as their class can at their
 * speed, and the follower does so on the grip it has, which in a wake is short of up to 16% of its downforce. A
 * follower that brakes worse than the car ahead must already be slower than it when the gap is small.
 */
export function followCap(me, cars, length, { react = 0.15, reach = 70, skip = null, tuck = null } = {}) {
  const env = envelope(me.classId), v = me.speed;
  const mine = at(env.brake, v) * (1 - 0.16 * (me.aero?.wake ?? 0) * downforceShare(env, v));
  let cap = Infinity;
  for (const o of cars) {
    if (o === me || o === skip || o.ghost) continue;
    const { ds, dl } = relative(me, o, length);
    // Yielding to `tuck`: it counts as the car ahead even alongside, and the room to it may be short (negative),
    // so the cap falls below its speed until COUNTERPOINT is a car length behind it.
    const yieldTo = o === tuck && ds > -LEN && ds < 15;
    if (!yieldTo && (ds <= 0 || ds > reach || Math.abs(dl) > WIDE)) continue;
    const vo = Math.max(0, o.speed), theirs = Math.max(4, at(envelope(o.classId).brake, vo));
    const room = yieldTo ? Math.max(-vo * vo / (2 * theirs), ds - LEN - v * react - 0.5) : Math.max(0, ds - LEN - v * react - 0.5);
    let c = Math.sqrt(2 * mine * Math.max(0, room + vo * vo / (2 * theirs)));
    // A follower that brakes harder still closes until the speeds meet, before either has stopped: that closest
    // approach is held to the room too.
    const dm = mine - theirs;
    if (dm > 0.3 && room > 0 && (c - vo) / dm < vo / theirs) c = Math.min(c, vo + Math.sqrt(2 * dm * room));
    cap = Math.min(cap, c);
  }
  return cap;
}

/** The cap a move is driven under: the follow rule when it follows, and behind the car it yields to when it yields. */
export function moveCap(me, cars, length, move) {
  if (!move?.follow) return Infinity;
  const tuck = move.yieldTo != null ? cars.find((c) => c.id === move.yieldTo) ?? null : null;
  return followCap(me, cars, length, { tuck });
}
