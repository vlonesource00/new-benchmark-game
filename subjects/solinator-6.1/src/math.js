export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const wrap = (x, n) => ((x % n) + n) % n;
export const angle = x => Math.atan2(Math.sin(x), Math.cos(x));
export const delta = (a, b, length) => wrap(a - b + length / 2, length) - length / 2;
export const lerp = (a, b, f) => a + (b - a) * f;
