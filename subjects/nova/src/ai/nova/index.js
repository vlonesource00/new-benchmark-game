/**
 * NOVA Proxy / Baseline Scaffold
 * 
 * These components serve as the PROXY / BASELINE scaffold for A/B testing
 * while the final research architecture is under development.
 */

export { NovaBeliefEngine as BeliefEngineProxy, NovaBeliefEngine, createBeliefEngine } from './belief-occupancy.js';
export { NovaValueField as ValueFieldProxy, NovaValueField, createValueField } from './value-field.js';
export { NovaTopologyPlanner as TopologyPlannerProxy, NovaTopologyPlanner, createTopologyPlanner, RACECRAFT_PHASE } from './topology-planner.js';
export {
  NovaCoupledController as CoupledControllerBaseline,
  NovaCoupledController,
  createCoupledController,
  TARGET_LIMIT_REASON,
  THROTTLE_LIMIT_REASON,
  BRAKE_REASON,
} from './coupled-controller.js';
export {
  SEMANTIC_ROLE,
  COMPETITIVE_ROLE,
  DYNAMIC_STATE,
  classifyCompetitor,
  classifyOpponentRole,
  isObstacleRole,
  isRacingCompetitor,
  isDynamicHazard
} from './roles.js';
export { RELATIVE_BODY_STATE, ATTACK_PHASE, InteractionEpisode, EpisodeTracker } from './interaction-episode.js';
export { NovaDriver, createNovaDriver } from './nova-driver.js';

