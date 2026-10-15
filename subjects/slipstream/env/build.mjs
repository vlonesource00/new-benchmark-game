// The worlds a worker steps, built from a worker config. Shared by env/worker.mjs and env/isolation.mjs, so the
// isolation test exercises exactly what training and the completion tests run.
import { World } from './world.mjs';

/** mulberry32: a small seeded generator, one independent stream per world. */
export const mkRng = (seed) => { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

/**
 * cfg: the worker config (worlds per worker, seed, tracks, weathers, world, alt). index: the worker's index.
 * World g (global ordinal = index * worlds + w) gets its own generator seeded from (cfg.seed, g): its starts, latency,
 * tyre and snapshot draws depend only on its own history, never on what other worlds do or on how worlds are split
 * over workers (a shared stream let one world's driving shift a neighbour's draws).
 */
export function buildWorlds(cfg, index) {
  const worlds = [];
  const tracks = cfg.tracks ?? ['harbor-ring'], weathers = cfg.weathers ?? ['clear'];
  // alt: world overrides for every other pass over the track pool (so each track gets both kinds), e.g. solo worlds
  // beside traffic worlds.
  for (let w = 0; w < cfg.worlds; w++) {
    const g = index * cfg.worlds + w;
    const alt = cfg.alt && Math.floor(g / tracks.length) % 2 === 1 ? cfg.alt : {};
    const rng = mkRng(Math.imul((cfg.seed ?? 1) + 1, 7919) ^ Math.imul(g + 1, 104729));
    worlds.push(new World({ ...cfg.world, ...alt, track: tracks[g % tracks.length], weather: weathers[Math.floor(g / tracks.length) % weathers.length], seed: 1000 + g * 31 + (cfg.seed ?? 1) }, rng));
  }
  return worlds;
}
