/**
 * Nova Semantic Object Roles & Dynamic State Engine (V4.1)
 * 
 * Separates competitor identity (competitiveRole) from instantaneous motion (dynamicState).
 * Active racers in heavy braking zones remain ACTIVE_RACER (not obstacles).
 * Rejoining cars are identified as dynamic hazards.
 */

export const COMPETITIVE_ROLE = Object.freeze({
  ACTIVE_RACER: 'ACTIVE_RACER',
  FINISHED_CAR: 'FINISHED_CAR',
  NON_COMPETITOR: 'NON_COMPETITOR'
});

export const DYNAMIC_STATE = Object.freeze({
  NORMAL: 'NORMAL',
  SLOW: 'SLOW',
  STOPPED: 'STOPPED',
  STRANDED: 'STRANDED',
  REJOINING: 'REJOINING'
});

export const SEMANTIC_ROLE = Object.freeze({
  ACTIVE_RACER: 'ACTIVE_RACER',
  FINISHED_CAR: 'FINISHED_CAR',
  STRANDED_OBSTACLE: 'STRANDED_OBSTACLE',
  SLOW_MOVING_OBSTACLE: 'SLOW_MOVING_OBSTACLE',
  REJOINING_CAR: 'REJOINING_CAR',
  DYNAMIC_HAZARD: 'DYNAMIC_HAZARD'
});

/**
 * Classifies an opponent vehicle into orthogonal (competitiveRole, dynamicState).
 * 
 * @param {Object} opp - Rival observation object
 * @param {Object} [ego] - Ego observation object
 * @param {Object} [trackRef] - Optional track reference
 * @returns {{ competitiveRole: string, dynamicState: string }}
 */
export function classifyCompetitor(opp, ego = null, trackRef = null) {
  if (!opp) {
    return {
      competitiveRole: COMPETITIVE_ROLE.ACTIVE_RACER,
      dynamicState: DYNAMIC_STATE.NORMAL
    };
  }

  // 1. Determine Competitive Role (Authoritative race identity)
  let competitiveRole = COMPETITIVE_ROLE.ACTIVE_RACER;
  if (opp.finished === true || (opp.finishTime !== undefined && opp.finishTime !== null) || opp.raceActive === false) {
    competitiveRole = COMPETITIVE_ROLE.FINISHED_CAR;
  } else if (opp.nonCompetitor === true || opp.isGhost === true) {
    competitiveRole = COMPETITIVE_ROLE.NON_COMPETITOR;
  }

  // 2. Determine Dynamic Motion State
  const speed = Number.isFinite(opp.speed) ? opp.speed : (Number.isFinite(opp.v) ? opp.v : 0);
  const q = Number.isFinite(opp.q) ? opp.q : 0;
  const dq = Number.isFinite(opp.dq) ? opp.dq : (Number.isFinite(opp.lateralVelocity) ? opp.lateralVelocity : (Number.isFinite(opp.qDot) ? opp.qDot : 0));
  const offtrack = Number.isFinite(opp.offtrack) ? opp.offtrack : 0;
  const roadHalfWidth = trackRef?.halfWidth || 8.2;

  let dynamicState = DYNAMIC_STATE.NORMAL;

  // Stopped / Stranded
  if (speed < 2.5) {
    const isOff = Math.abs(q) > (roadHalfWidth - 1.5) || offtrack > 0.35;
    dynamicState = isOff ? DYNAMIC_STATE.STRANDED : DYNAMIC_STATE.STOPPED;
  }
  // Rejoining car: off track or returning inward across boundaries
  else if ((Math.abs(q) > (roadHalfWidth - 1.5) || offtrack > 0.35) && (Math.sign(q) * dq < -0.30)) {
    dynamicState = DYNAMIC_STATE.REJOINING;
  }
  // Slow motion state (e.g. corner apex or heavy braking zone)
  else {
    const egoSpeed = ego?.speed ?? ego?.v ?? 40;
    if (speed < 16.0 || (egoSpeed > 35.0 && speed < egoSpeed - 20.0)) {
      dynamicState = DYNAMIC_STATE.SLOW;
    }
  }

  return { competitiveRole, dynamicState };
}

/**
 * Backward compatibility: maps competitor classification to SEMANTIC_ROLE string.
 */
export function classifyOpponentRole(opp, ego = null, trackRef = null) {
  const { competitiveRole, dynamicState } = classifyCompetitor(opp, ego, trackRef);

  if (competitiveRole === COMPETITIVE_ROLE.FINISHED_CAR) {
    return SEMANTIC_ROLE.FINISHED_CAR;
  }
  if (competitiveRole === COMPETITIVE_ROLE.NON_COMPETITOR) {
    return SEMANTIC_ROLE.FINISHED_CAR;
  }
  if (dynamicState === DYNAMIC_STATE.REJOINING) {
    return SEMANTIC_ROLE.REJOINING_CAR;
  }
  if (dynamicState === DYNAMIC_STATE.STRANDED || dynamicState === DYNAMIC_STATE.STOPPED) {
    return SEMANTIC_ROLE.STRANDED_OBSTACLE;
  }
  // An active racer (even when DYNAMIC_STATE.SLOW during heavy braking) remains ACTIVE_RACER!
  if (competitiveRole === COMPETITIVE_ROLE.ACTIVE_RACER) {
    return SEMANTIC_ROLE.ACTIVE_RACER;
  }
  return SEMANTIC_ROLE.ACTIVE_RACER;
}

/**
 * Returns true if the object should be treated as an obstacle to be bypassed
 * rather than an active competitor to engage in racing combat.
 */
export function isObstacleRole(role, dynamicState = null) {
  if (typeof role === 'object' && role !== null) {
    dynamicState = role.dynamicState;
    role = role.competitiveRole;
  }
  if (role === COMPETITIVE_ROLE.FINISHED_CAR || role === COMPETITIVE_ROLE.NON_COMPETITOR) {
    return true;
  }
  if (role === SEMANTIC_ROLE.FINISHED_CAR) {
    return true;
  }
  if (dynamicState === DYNAMIC_STATE.STOPPED || dynamicState === DYNAMIC_STATE.STRANDED) {
    return true;
  }
  if (role === SEMANTIC_ROLE.STRANDED_OBSTACLE || role === SEMANTIC_ROLE.SLOW_MOVING_OBSTACLE) {
    return true;
  }
  return false;
}

/**
 * Returns true if the object is an active competitor engaged in racing combat.
 * Gemini braking heavily into hairpin = ACTIVE_RACER + SLOW => returns true.
 */
export function isRacingCompetitor(role, dynamicState = null) {
  if (typeof role === 'object' && role !== null) {
    dynamicState = role.dynamicState;
    role = role.competitiveRole;
  }
  if (role !== COMPETITIVE_ROLE.ACTIVE_RACER && role !== SEMANTIC_ROLE.ACTIVE_RACER) {
    return false;
  }
  // Stopped, stranded, or rejoining cars leave tactical racecraft
  if (dynamicState === DYNAMIC_STATE.STOPPED ||
      dynamicState === DYNAMIC_STATE.STRANDED ||
      dynamicState === DYNAMIC_STATE.REJOINING) {
    return false;
  }
  return true;
}

/**
 * Returns true if the object is a rejoining car that must be treated as a dynamic hazard.
 */
export function isDynamicHazard(role, dynamicState = null) {
  if (typeof role === 'object' && role !== null) {
    dynamicState = role.dynamicState;
    role = role.competitiveRole;
  }
  return dynamicState === DYNAMIC_STATE.REJOINING ||
         role === SEMANTIC_ROLE.REJOINING_CAR ||
         role === SEMANTIC_ROLE.DYNAMIC_HAZARD;
}
