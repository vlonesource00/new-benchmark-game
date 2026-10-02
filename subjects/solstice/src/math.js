export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const wrap = (v, length) => ((v % length) + length) % length;
export const angle = v => Math.atan2(Math.sin(v), Math.cos(v));
export const distance = (a, b, length) => wrap(a - b + length / 2, length) - length / 2;
