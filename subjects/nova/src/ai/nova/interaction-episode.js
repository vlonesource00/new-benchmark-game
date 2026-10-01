/**
 * Nova Interaction Episode & Corridor Ownership Engine (V4)
 * 
 * Manages persistent multi-car combat episodes, body-interval relative states,
 * and dedicated lateral corridor ownership through corner complexes.
 */

import { SEMANTIC_ROLE, classifyOpponentRole } from './roles.js';

export const RELATIVE_BODY_STATE = Object.freeze({
  FAR_AHEAD: 'FAR_AHEAD',
  BEHIND: 'BEHIND',                 // Ego is behind rival (rival is ahead)
  PRE_OVERLAP: 'PRE_OVERLAP',       // Ego front approaching rival rear within combat striking distance
  OVERLAPPING: 'OVERLAPPING',       // Front/rear body intervals overlap longitudinally
  CLEARING: 'CLEARING',             // Ego rear bumper is past rival front, securing merge corridor
  PASS_COMPLETE: 'PASS_COMPLETE',   // Cleanly clear and safely merged back into racing line
  FAR_BEHIND: 'FAR_BEHIND'          // Rival is far behind ego
});

export const ATTACK_PHASE = Object.freeze({
  STALKING: 'STALKING',
  COMMITTED: 'COMMITTED',
  SIDE_BY_SIDE: 'SIDE_BY_SIDE',
  CLEARING: 'CLEARING',
  COMPLETED: 'COMPLETED',
  ABORTED: 'ABORTED'
});

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function wrapTrack(ds, length) {
  if (!length || length <= 0) return ds;
  let d = ((ds % length) + length) % length;
  if (d > length / 2) d -= length;
  return d;
}

export class InteractionEpisode {
  constructor(rivalId, role, currentTime = 0) {
    this.rivalId = rivalId;
    this.role = role;
    this.startTime = currentTime;
    this.lastUpdateTime = currentTime;
    this.age = 0;

    // Body intervals and relative state
    this.bodyState = RELATIVE_BODY_STATE.BEHIND;
    this.previousBodyState = null;
    this.ds = Infinity;
    this.minDs = Infinity;
    this.longitudinalOverlap = 0;
    this.lateralGap = 0;
    this.overlapDuration = 0;
    this.passCompleted = false;
    this.hasInitiatedAttack = false;
    this.hasReachedOverlap = false;

    // Corridor Ownership
    this.selectedSide = 0; // -1 for Left/Inside, +1 for Right/Outside
    this.ownedCorridor = null; // [qLow, qHigh] assigned to ego
    this.rivalCorridor = null; // [qLow, qHigh] occupied by rival
    this.targetCorridorQ = 0;  // Centerline of owned corridor
    this.corridorLocked = false;

    // Maneuver lifecycle
    this.attackPhase = ATTACK_PHASE.STALKING;
    this.commitmentTime = 0;
    this.overlapDuration = 0;
    this.passCompleted = false;
    this.cleanAbort = false;
    this.minDs = Infinity;

    // Metrics for racecraft analysis (Section 12)
    this.metrics = {
      catchTime: null,
      attackCommitTime: null,
      overlapStartTime: null,
      overlapDuration: 0,
      passCompleteTime: null,
      speedLossMps: 0,
      speedMatchTime: 0,
      sideBySideBrakeTime: 0,
    };
  }

  update({
    ego,
    rival,
    currentTime,
    dt,
    trackLength,
    legalQ,
    freeExitAvailable,
    currentKappa = 0
  }) {
    this.lastUpdateTime = currentTime;
    this.age = currentTime - this.startTime;
    const egoL = ego.halfLength ?? 2.325;
    const rivalL = rival.halfLength ?? 2.325;
    const egoW = ego.halfWidth ?? 1.01;
    const rivalW = rival.halfWidth ?? 1.01;
    const minLongMargin = 0.50;

    // Track station delta (rival.s - ego.s)
    const ds = wrapTrack((rival.s ?? 0) - (ego.s ?? 0), trackLength);
    this.ds = ds;
    this.minDs = Math.min(this.minDs, ds);

    // Exact body front/rear stations relative to ego center (ego is at [ -egoL, +egoL ])
    const egoFront = egoL;
    const egoRear = -egoL;
    const rivalFront = ds + rivalL;
    const rivalRear = ds - rivalL;

    // Longitudinal overlap calculation:
    // Overlap exists whenever egoFront > rivalRear - minLongMargin AND egoRear < rivalFront + minLongMargin
    const isOverlapping = (egoFront >= rivalRear - minLongMargin) && (egoRear <= rivalFront + minLongMargin);
    this.longitudinalOverlap = isOverlapping
      ? Math.min(egoFront - rivalRear, rivalFront - egoRear)
      : 0;

    const latGap = Math.abs((ego.q ?? 0) - (rival.q ?? 0));
    this.lateralGap = latGap;

    // Classify relative body state using physical bounding boxes
    this.previousBodyState = this.bodyState;
    if (ds > (egoL + rivalL + 8.0)) {
      this.bodyState = RELATIVE_BODY_STATE.FAR_AHEAD;
    } else if (ds > (egoL + rivalL + minLongMargin)) {
      // Rival is clearly ahead of ego bumper
      this.bodyState = ds < (egoL + rivalL + 3.5)
        ? RELATIVE_BODY_STATE.PRE_OVERLAP
        : RELATIVE_BODY_STATE.BEHIND;
    } else if (isOverlapping) {
      this.bodyState = RELATIVE_BODY_STATE.OVERLAPPING;
      this.hasReachedOverlap = true;
      if (!this.metrics.overlapStartTime) {
        this.metrics.overlapStartTime = currentTime;
      }
      this.overlapDuration += dt;
      this.metrics.overlapDuration = this.overlapDuration;
    } else if (egoRear > rivalFront) {
      // Ego rear bumper is ahead of rival front bumper (rival is behind ego)
      const rearBumperMargin = egoRear - rivalFront;
      if (this.hasReachedOverlap || this.hasInitiatedAttack) {
        if (rearBumperMargin >= 1.8 && freeExitAvailable) {
          this.bodyState = RELATIVE_BODY_STATE.PASS_COMPLETE;
          this.passCompleted = true;
          if (!this.metrics.passCompleteTime) {
            this.metrics.passCompleteTime = currentTime;
          }
        } else if (rearBumperMargin < 4.5) {
          this.bodyState = RELATIVE_BODY_STATE.CLEARING;
        } else {
          this.bodyState = RELATIVE_BODY_STATE.FAR_BEHIND;
        }
      } else {
        // Ego was never in an attack or overlap with this rival; rival is simply behind ego
        this.bodyState = RELATIVE_BODY_STATE.FAR_BEHIND;
      }
    } else {
      this.bodyState = RELATIVE_BODY_STATE.FAR_BEHIND;
    }

    // Update attack phase
    if (this.bodyState === RELATIVE_BODY_STATE.PASS_COMPLETE) {
      this.attackPhase = ATTACK_PHASE.COMPLETED;
    } else if (this.bodyState === RELATIVE_BODY_STATE.CLEARING) {
      this.attackPhase = ATTACK_PHASE.CLEARING;
    } else if (this.bodyState === RELATIVE_BODY_STATE.OVERLAPPING) {
      this.attackPhase = ATTACK_PHASE.SIDE_BY_SIDE;
    } else if (this.selectedSide !== 0 && this.bodyState === RELATIVE_BODY_STATE.PRE_OVERLAP) {
      this.attackPhase = ATTACK_PHASE.COMMITTED;
      this.commitmentTime += dt;
    } else {
      this.attackPhase = ATTACK_PHASE.STALKING;
    }

    // Maintain Corridor Ownership throughout overlap and clearing
    this._updateCorridorOwnership(ego, rival, legalQ, currentKappa);
  }

  /**
   * Computes and solidifies non-overlapping lateral corridors:
   * Gemini: [qLow_G, qHigh_G]
   * NOVA:   [qLow_N, qHigh_N]
   * The corridor ownership persists through braking, turn-in, apex, and exit!
   */
  _updateCorridorOwnership(ego, rival, legalQ, currentKappa) {
    const egoW = ego.halfWidth ?? 1.01;
    const rivalW = rival.halfWidth ?? 1.01;
    const latSafetyMargin = 0.65; // Safe door-to-door racing clearance
    const totalHalfWidthBuffer = egoW + rivalW + latSafetyMargin; // ~2.67m

    const egoQ = ego.q ?? 0;
    const rivalQ = rival.q ?? 0;

    // Use established selected side if present, otherwise default to relative position for corridor geometry
    const side = this.selectedSide !== 0 ? this.selectedSide : (egoQ >= rivalQ ? 1 : -1);

    if (side < 0) {
      // Ego owns the LEFT / INSIDE corridor
      const maxEgoQ = clamp(rivalQ - totalHalfWidthBuffer, -legalQ + 1.2, legalQ - 1.2);
      this.ownedCorridor = [-legalQ, maxEgoQ];
      this.rivalCorridor = [rivalQ - rivalW, Math.min(legalQ, rivalQ + rivalW)];
      this.targetCorridorQ = clamp(egoQ, -legalQ + 0.3, maxEgoQ);
    } else {
      // Ego owns the RIGHT / OUTSIDE corridor
      const minEgoQ = clamp(rivalQ + totalHalfWidthBuffer, -legalQ + 1.2, legalQ - 1.2);
      this.ownedCorridor = [minEgoQ, legalQ];
      this.rivalCorridor = [Math.max(-legalQ, rivalQ - rivalW), rivalQ + rivalW];
      this.targetCorridorQ = clamp(egoQ, minEgoQ, legalQ - 0.3);
    }

    // Lock corridor once overlap or clearing is active
    if (this.bodyState === RELATIVE_BODY_STATE.OVERLAPPING || this.bodyState === RELATIVE_BODY_STATE.CLEARING) {
      this.corridorLocked = true;
    }
  }

  isCorridorDisjoint(egoQ, rivalQ) {
    if (!this.ownedCorridor || !this.rivalCorridor) return true;
    const margin = 0.40;
    return (this.ownedCorridor[1] < this.rivalCorridor[0] - margin) ||
           (this.ownedCorridor[0] > this.rivalCorridor[1] + margin);
  }
}

/**
 * Manages active interaction episodes across all visible opponents
 */
export class EpisodeTracker {
  constructor() {
    this.episodes = new Map(); // rivalId -> InteractionEpisode
    this.completedEpisodes = [];
    this.activeRivalId = null;
    this.isThreeWide = false;
    this.threeWideDetails = null;
  }

  reset() {
    this.episodes.clear();
    this.completedEpisodes = [];
    this.activeRivalId = null;
    this.isThreeWide = false;
    this.threeWideDetails = null;
  }

  getEpisode(rivalId) {
    if (rivalId == null) return null;
    return this.episodes.get(rivalId) || null;
  }

  getActiveEpisode() {
    if (this.activeRivalId == null) return null;
    return this.episodes.get(this.activeRivalId) || null;
  }

  update({
    ego,
    opponents = [],
    currentTime = 0,
    dt = 1 / 120,
    trackLength = 2704.62,
    legalQ = 6.2,
    beliefOccupancy = null,
    currentKappa = 0
  }) {
    const activeIds = new Set();

    for (const opp of opponents) {
      if (!opp || opp.id == null) continue;
      activeIds.add(opp.id);

      const role = classifyOpponentRole(opp, ego);
      let ep = this.episodes.get(opp.id);

      // Create new episode if opponent is nearby and none exists
      const ds = Math.abs(wrapTrack((opp.s ?? 0) - (ego.s ?? 0), trackLength));
      if (!ep && ds < 45.0) {
        ep = new InteractionEpisode(opp.id, role, currentTime);
        this.episodes.set(opp.id, ep);
      }

      if (ep) {
        ep.role = role;
        // Check if merge return corridor is free downstream (defaults to true if unconstrained/no belief)
        const freeExitAvailable = beliefOccupancy
          ? Boolean(
              beliefOccupancy.freeIntervalsAt?.(
                (ego.s ?? 0) + (ego.speed ?? 30) * 0.4, 0.4, -legalQ, legalQ, trackLength
              )?.length > 0
            )
          : true;

        ep.update({
          ego,
          rival: opp,
          currentTime,
          dt,
          trackLength,
          legalQ,
          freeExitAvailable,
          currentKappa
        });
      }
    }

    // Determine the primary active combat rival:
    // 1. Prioritize overlapping rival (active side-by-side combat)
    // 2. Prioritize clearing rival (securing merge corridor)
    // 3. Prioritize committed attack rival (holding corridor into corner)
    let bestRivalId = null;
    let minCombatDistance = Infinity;

    for (const [id, ep] of this.episodes.entries()) {
      if (ep.bodyState === RELATIVE_BODY_STATE.OVERLAPPING) {
        bestRivalId = id;
        break;
      }
      if (ep.bodyState === RELATIVE_BODY_STATE.CLEARING) {
        bestRivalId = id;
        break;
      }
      if (ep.hasInitiatedAttack && (ep.bodyState === RELATIVE_BODY_STATE.PRE_OVERLAP || ep.bodyState === RELATIVE_BODY_STATE.BEHIND)) {
        const absDs = Math.abs(ep.ds);
        if (absDs < minCombatDistance && absDs < 35.0) {
          minCombatDistance = absDs;
          bestRivalId = id;
        }
      }
    }

    this.activeRivalId = bestRivalId;

    // Diagnostic: Check for Three-Wide condition (rival A overlapping left, rival B overlapping right)
    const egoQ = ego.q ?? 0;
    const egoW = ego.halfWidth ?? 1.01;
    let leftRival = null;
    let rightRival = null;

    for (const [id, ep] of this.episodes.entries()) {
      if (ep.bodyState === RELATIVE_BODY_STATE.OVERLAPPING) {
        const oppObj = opponents.find(o => o?.id === id);
        const rivalQ = oppObj?.q ?? (ep.rivalCorridor ? (ep.rivalCorridor[0] + ep.rivalCorridor[1]) / 2 : 0);
        if (rivalQ < egoQ - 0.5) {
          if (!leftRival || rivalQ > leftRival.q) {
            leftRival = { id, q: rivalQ, corridor: ep.rivalCorridor };
          }
        } else if (rivalQ > egoQ + 0.5) {
          if (!rightRival || rivalQ < rightRival.q) {
            rightRival = { id, q: rivalQ, corridor: ep.rivalCorridor };
          }
        }
      }
    }

    if (leftRival && rightRival) {
      this.isThreeWide = true;
      const leftBoundary = leftRival.corridor ? leftRival.corridor[1] : (leftRival.q + 1.01);
      const rightBoundary = rightRival.corridor ? rightRival.corridor[0] : (rightRival.q - 1.01);
      const availableWidth = rightBoundary - leftBoundary;
      this.threeWideDetails = {
        leftRivalId: leftRival.id,
        rightRivalId: rightRival.id,
        leftGap: egoQ - leftRival.q,
        rightGap: rightRival.q - egoQ,
        availableWidth,
        isPinched: availableWidth < (2 * egoW + 0.40)
      };
    } else {
      this.isThreeWide = false;
      this.threeWideDetails = null;
    }

    // Prune stale episodes that have passed or fallen far away (> 50m)
    for (const [id, ep] of this.episodes.entries()) {
      if (!activeIds.has(id) || Math.abs(ep.ds) > 65.0 || ep.attackPhase === ATTACK_PHASE.COMPLETED && ep.age > 4.0) {
        if (ep.passCompleted) {
          this.completedEpisodes.push(ep);
        }
        this.episodes.delete(id);
      }
    }

    return this.getActiveEpisode();
  }
}
