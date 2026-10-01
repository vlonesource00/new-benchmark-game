// Loads the forged ghost tape shipped with PHANTOM, or seeds one.
import { Ghost, seedGhost } from './ghost.js';

export async function loadGhost(track, car) {
  let ghost = null;
  try {
    const mod = await import('./ghost-data.js');
    const d = mod.GHOST;
    if (d && Math.abs(d.length - track.length) < 1e-6) ghost = new Ghost(d);
  } catch { /* no forged tape yet */ }
  ghost ??= seedGhost(track);
  ghost.calibrate(track, car);
  ghost.buildEnvelope();
  return ghost;
}

export function ghostFromData(d, track, car) {
  const ghost = new Ghost(d);
  ghost.calibrate(track, car);
  ghost.buildEnvelope();
  return ghost;
}
