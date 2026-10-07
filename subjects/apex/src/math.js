export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const wrap = (x, n) => ((x % n) + n) % n;
export const angle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const lerp = (a, b, t) => a + (b - a) * t;
export const sign = (x) => (x < 0 ? -1 : 1);

/** Piecewise-linear lookup in a [[x, y], ...] table, clamped at both ends. */
export function table(t, x) {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (x <= t[i][0]) {
    const [x0, y0] = t[i - 1], [x1, y1] = t[i];
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return t[t.length - 1][1];
}
