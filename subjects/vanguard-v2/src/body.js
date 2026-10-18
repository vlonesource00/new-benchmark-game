import { HALF_LENGTH, HALF_WIDTH } from './observer.js';

/** Four separating axes and exact chassis dimensions matching the host plant. */
export function bodyContact(a, b, padding = 0) {
  const ar = [Math.cos(a.h), -Math.sin(a.h)], af = [Math.sin(a.h), Math.cos(a.h)],
    br = [Math.cos(b.h), -Math.sin(b.h)], bf = [Math.sin(b.h), Math.cos(b.h)];
  const dx = b.x - a.x, dz = b.z - a.z;
  let depth = Infinity, nx = 0, nz = 0;
  for (const axis of [ar, af, br, bf]) {
    const dot = q => Math.abs(axis[0] * q[0] + axis[1] * q[1]);
    const overlap = (HALF_WIDTH + padding) * (dot(ar) + dot(br)) + (HALF_LENGTH + padding) * (dot(af) + dot(bf)) - Math.abs(dx * axis[0] + dz * axis[1]);
    if (overlap <= 0) return null;
    if (overlap < depth) {
      depth = overlap;
      const sign = Math.sign(dx * axis[0] + dz * axis[1]) || 1;
      nx = axis[0] * sign; nz = axis[1] * sign;
    }
  }
  const closing = Math.max(0, (a.vx - b.vx) * nx + (a.vz - b.vz) * nz),
    longitudinal = Math.abs(nx * af[0] + nz * af[1]);
  return { depth, closing, longitudinal };
}
