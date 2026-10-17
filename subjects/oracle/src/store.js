// Baked lines: offsets, tarmac bounds and learned grip per track and class (tools/bake.mjs writes them).
import lines from '../data/lines.json' with { type: 'json' };

export const lineData = (trackId, classId) => lines[`${trackId}:${classId}`] ?? null;
