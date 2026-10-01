import { createSolinatorBridge } from '../../subjects/solinator-6.1/src/driver.js';
import calibrated from '../../subjects/solinator-6.1/config/calibrated.json';

export const SOLINATOR_CANDIDATE = Object.freeze({
  id: 'solinator-6.1',
  label: 'SOLINATOR 6.1',
  color: '#ffce45',
  stack: 'Cartesian gate arrivals → executable physical transfers → opponent body occupancy + four-wheel tyre resources'
});

/**
 * Solinator 6.1 with its calibrated config; builds its own road model from any host track.
 * The road deformations are station-indexed for Harbor Ring, so other tracks get the bare model.
 */
export function createBenchmarkSolinatorBridge({ hostTrack, index = 0, options = {} }) {
  const road = hostTrack.id === 'harbor-ring' ? calibrated.road : { ...calibrated.road, deformations: [] };
  return {
    ...SOLINATOR_CANDIDATE,
    native: true,
    ...createSolinatorBridge({
      hostTrack, index,
      options: { ...calibrated, ...options, road: { ...road, ...options.road }, policy: { ...calibrated.policy, ...options.policy } }
    })
  };
}
