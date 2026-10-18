export { clamp, angle } from '../../apex/src/math.js';
export const wrap = (s, length) => ((s % length) + length) % length;
export const gap = (s, origin, length) => wrap(s - origin + length / 2, length) - length / 2;
export const ease = (u) => { u = Math.max(0, Math.min(1, u)); return u * u * u * (10 + u * (-15 + 6 * u)); };
export function advance(path, i, f, distance) {
  let x = f * path.len[i] + distance, n = 0;
  while (x >= path.len[i] && n++ < path.N) { const j = path.idx(i + 1); if (j === i) break; x -= path.len[i]; i = j; }
  while (x < 0 && n++ < path.N) { const j = path.idx(i - 1); if (j === i) break; i = j; x += path.len[i]; }
  return { i, f: Math.max(0, Math.min(1, x / Math.max(0.01, path.len[i]))) };
}
export function roadSample(path, i, f, length) {
  const j = path.idx(i + 1);
  return wrap(path.st[i] + gap(path.st[j], path.st[i], length) * f, length);
}
// A quintic boundary join preserves lateral position, slope and curvature.
export function join(d0, slope, second, d1, length, x) {
  const t = Math.max(0, Math.min(1, x / Math.max(1e-3, length))), a = slope * length, b = second * length * length / 2;
  const c = d1 - d0;
  return d0 + a * t + b * t * t + (10 * c - 6 * a - 3 * b) * t ** 3 + (-15 * c + 8 * a + 3 * b) * t ** 4 + (6 * c - 3 * a - b) * t ** 5;
}
