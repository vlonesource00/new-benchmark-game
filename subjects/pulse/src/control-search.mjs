// Offline control-space exploration. No maneuver categories or runtime planner.
export function smoothControlDelta(candidate, time, branchAt) {
  const u = (time - branchAt) / candidate.duration;
  if (u <= 0 || u >= 1) return [0, 0];
  if (!candidate.knots) {
    const envelope = Math.sin(Math.PI * u) ** 2;
    return [candidate.steer * envelope, candidate.longitudinal * envelope];
  }
  const q = u * (candidate.knots.length - 1), at = Math.floor(q), blend = (1 - Math.cos(Math.PI * (q - at))) / 2;
  return candidate.knots[at].map((v, axis) => v * (1 - blend) + candidate.knots[at + 1][axis] * blend);
}

export function controlSearch({ seed = 19, population = 20, generations = 3, duration = 6,
  steerBound = .1, pedalBound = .3 } = {}) {
  if (!Number.isInteger(seed) || !Number.isInteger(population) || population < 8 || population > 64
    || !Number.isInteger(generations) || generations < 1 || generations > 6 || duration < 2 || duration > 10
    || !(steerBound > 0 && steerBound <= .15) || !(pedalBound > 0 && pedalBound <= .5)) throw Error('Invalid bounded control search');
  let state = seed >>> 0;
  const uniform = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state + 1) / 4294967297; };
  const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  let mean = new Array(6).fill(0), spread = mean.map((_, i) => (i % 2 ? pedalBound : steerBound) * .5);
  const bounds = mean.map((_, i) => i % 2 ? pedalBound : steerBound);
  return { generations,
    sample(generation) {
      return Array.from({ length: population }, (_, i) => {
        const vector = mean.map((v, j) => Math.max(-bounds[j], Math.min(bounds[j], v + (i ? normal() * spread[j] : 0))));
        return { label: 'search-g' + generation + '-n' + i, kind: 'smooth-control-sequence', duration,
          vector, knots: [[0, 0], vector.slice(0, 2), vector.slice(2, 4), vector.slice(4, 6), [0, 0]] };
      });
    },
    update(trials) {
      const elite = trials.filter(t => Number.isFinite(t.searchCost) && t.identicalPrefix)
        .sort((a, b) => a.searchCost - b.searchCost).slice(0, Math.max(2, Math.floor(population / 4)));
      if (!elite.length) return { mean: [...mean], spread: [...spread], elites: [] };
      mean = mean.map((_, j) => elite.reduce((sum, t) => sum + t.candidate.vector[j], 0) / elite.length);
      spread = spread.map((_, j) => Math.max(bounds[j] * .08,
        Math.sqrt(elite.reduce((sum, t) => sum + (t.candidate.vector[j] - mean[j]) ** 2, 0) / elite.length)));
      return { mean: [...mean], spread: [...spread], elites: elite.map(t => t.candidate.label) };
    }
  };
}
