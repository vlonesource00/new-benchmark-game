import {
  SEMANTIC_ROLE,
  COMPETITIVE_ROLE,
  DYNAMIC_STATE,
  classifyCompetitor,
  classifyOpponentRole,
  isObstacleRole,
  isRacingCompetitor,
  isDynamicHazard
} from './roles.js';
import { RELATIVE_BODY_STATE, ATTACK_PHASE, EpisodeTracker } from './interaction-episode.js';

/**
 * Traffic planner. Every candidate is a deformation of the measured free-air
 * line. The winning candidate's station-indexed trajectory is passed directly
 * to the steering controller.
 */
export const RACECRAFT_PHASE = Object.freeze({
  FREE: 'FREE',
  FOLLOW: 'FOLLOW',
  ATTACK_SETUP: 'ATTACK_SETUP',
  ATTACK_COMMITTED: 'ATTACK_COMMITTED',
  PRE_OVERLAP: 'PRE_OVERLAP',
  OVERLAP: 'OVERLAP',
  CLEARING: 'CLEARING',
  PASS_COMPLETE: 'PASS_COMPLETE',
  DEFEND_COMMITTED: 'DEFEND_COMMITTED',
  CONCEDE: 'CONCEDE',
  ABORT: 'ABORT',
});

export const V42_FLAGS = Object.freeze({
  fixA_corridorReachability: true,
  fixB_consistentSweptQ: true,
  fixC_closeFollowGapLaw: true,
  fixEarlyPullout: true,
});

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const smoothstep = (x) => { const u = clamp(x, 0, 1); return u * u * (3 - 2 * u); };
const wrapTrack = (d, length) => ((d + length * 1.5) % length) - length * 0.5;

export class NovaTopologyPlanner {
  constructor(config = {}) {
    this.horizon = config.horizon ?? 3.0;
    this.hysteresisMargin = config.hysteresisMargin ?? 0.35;
    this.envelope = config.envelope ?? null;
    this.flags = {
      fixA_corridorReachability: config.fixA_corridorReachability ?? true,
      fixB_consistentSweptQ: config.fixB_consistentSweptQ ?? true,
      fixC_closeFollowGapLaw: config.fixC_closeFollowGapLaw ?? true,
      fixEarlyPullout: config.fixEarlyPullout ?? true,
      ...(config.flags ?? {})
    };
    this.currentTopology = 'FREE_AIR';
    this.phase = RACECRAFT_PHASE.FREE;
    this.targetId = null;
    this.episodeId = 0;
    this.selectedSide = 0;
    this.selectedCorridor = [-6.2, 6.2];
    this.commitmentTime = 0;
    this.targetAge = 0;
    this.maneuverAge = 0;
    this.targetQ = 0;
    this.targetSpeedCap = Infinity;
    this.lastTime = null;
    this.lastEgoQ = null;
    this.egoQDot = 0;
    this.lastAttackId = null;
    this.abortUntil = -Infinity;
    this.attackCooldownUntil = -Infinity;
    this.lastSpeedCapReason = null;
    this.episodeTracker = new EpisodeTracker();
  }

  reset() {
    this.currentTopology = 'FREE_AIR';
    this.phase = RACECRAFT_PHASE.FREE;
    this.targetId = null;
    this.episodeId = 0;
    this.selectedSide = 0;
    this.selectedCorridor = [-6.2, 6.2];
    this.commitmentTime = 0;
    this.targetAge = 0;
    this.maneuverAge = 0;
    this.targetQ = 0;
    this.targetSpeedCap = Infinity;
    this.lastTime = null;
    this.lastEgoQ = null;
    this.egoQDot = 0;
    this.lastAttackId = null;
    this.abortUntil = -Infinity;
    this.attackCooldownUntil = -Infinity;
    this.lastSpeedCapReason = null;
    this.episodeTracker.reset();
  }

  _availableLat(v) {
    if (this.envelope?.latMax) return this.envelope.latMax(v);
    return Math.min(18.5, 12.0 + 0.0018 * v * v);
  }

  _availableBrake(v, latAccel = 0) {
    if (this.envelope?.brakeMax) return this.envelope.brakeMax(v, latAccel);
    const aMax0 = 11.5 + 0.0020 * v * v;
    const latCap = this._availableLat(v);
    const r = clamp(latAccel / Math.max(0.1, latCap), 0, 1);
    return aMax0 * Math.sqrt(Math.max(0.04, 1 - r * r));
  }

  _ref(s, ref) {
    if (!ref?.q?.length) return { q: 0, v: 30, kappa: 0 };
    const length = ref.length || ref.q.length * ref.ds;
    const x = (((s % length) + length) % length) / ref.ds;
    const i = Math.floor(x) % ref.q.length;
    const j = (i + 1) % ref.q.length;
    const t = x - Math.floor(x);
    return {
      q: ref.q[i] + (ref.q[j] - ref.q[i]) * t,
      v: ref.v ? ref.v[i] + (ref.v[j] - ref.v[i]) * t : 30,
      kappa: ref.kappa ? ref.kappa[i] + (ref.kappa[j] - ref.kappa[i]) * t : 0
    };
  }

  _trajectory(topology, ego, lead, gap, adjacent, ref, legalQ, defend = false, corridorGraph = null, nearby = [], activeEpisode = null, staticObstacles = [], dynamicHazards = []) {
    const s0 = ego.s ?? 0;
    const v = Math.max(5, ego.speed ?? ego.v ?? 30);
    const leadV = lead ? (lead.speed ?? lead.v ?? v) : v;
    const closing = Math.max(0, v - leadV);
    const horizonS = v * this.horizon;
    const encounterT = lead ? clamp((gap - 2.5) / Math.max(1, closing), 0.4, this.horizon) : this.horizon;
    const encounterS = s0 + v * encounterT;
    const side = topology === 'H_OUTSIDE' ? 1 : topology === 'H_INSIDE' ? -1 : 0;
    const delayed = topology === 'H_SWITCHBACK';
    const encounterLayer = corridorGraph?.layers?.reduce((best, layer) =>
      Math.abs(layer.t - encounterT) < Math.abs(best.t - encounterT) ? layer : best);
    const flank = side && encounterLayer?.intervals
      .filter(interval => interval.reachable && (side > 0 ? interval.lo > (lead?.q ?? 0) : interval.hi < (lead?.q ?? 0)))
      .sort((a, b) => Math.abs(a.center - this._ref(encounterS, ref).q) -
        Math.abs(b.center - this._ref(encounterS, ref).q))[0];
    const nodes = [];
    const count = 12;
    // The small defensive move follows the bend's inside, and vanishes at
    // both ends of the horizon so entry and exit remain on the fast line.
    const startQ = this._ref(s0, ref).q;
    const endQ = this._ref(s0 + horizonS, ref).q;
    let apexDeviation = 0;
    if (defend && topology === 'H_FOLLOW') {
      for (let i = 1; i < count; i++) {
        const u = i / count;
        const deviation = this._ref(s0 + horizonS * u, ref).q - (startQ + (endQ - startQ) * u);
        if (Math.abs(deviation) > Math.abs(apexDeviation)) apexDeviation = deviation;
      }
    }
    const egoQ = ego.q ?? 0;
    const egoDq = ego.lateralVelocity ?? ego.dq ?? this.egoQDot ?? 0;

    for (let i = 0; i <= count; i++) {
      const t = this.horizon * i / count;
      const s = s0 + v * t;
      const nominal = this._ref(s, ref);
      let q = nominal.q;

      // CORRIDOR OWNERSHIP (Sections 6 & 7):
      // During combat overlap or active flank commitment, the assigned lateral corridor IS NOVA's racing line.
      // It exists independent of lead status and does not snap back toward nominal line mid-corner.
      if (activeEpisode && (activeEpisode.bodyState === 'OVERLAPPING' || activeEpisode.bodyState === 'CLEARING' || activeEpisode.bodyState === 'PRE_OVERLAP')) {
        const ownedQ = activeEpisode.targetCorridorQ;
        const sRival = s0 + activeEpisode.ds;
        const sPast = s - sRival;
        const egoL = ego.halfLength ?? 2.325;
        if (sPast < egoL + 5.0 || activeEpisode.bodyState !== 'PASS_COMPLETE') {
          q = ownedQ;
        } else {
          const blendOut = smoothstep((sPast - (egoL + 5.0)) / 16.0);
          q = ownedQ + (nominal.q - ownedQ) * blendOut;
        }
      } else if (side && lead) {
        // Pre-overlap approach to flank
        const leadQ = lead.q ?? 0;
        const clearance = (lead.halfWidth ?? 1.01) + 1.01 + 1.35;
        const geometricTarget = flank ? clamp(this._ref(encounterS, ref).q, flank.lo + 0.05, flank.hi - 0.05) :
          leadQ + side * clearance;
        const needed = Math.max(0, side * (geometricTarget - nominal.q));
        const leadStation = s0 + gap + leadV * t;
        const relative = leadStation - s;
        const riseDist = Math.max(18, Math.min(38, v * 0.60));
        const rise = smoothstep((s - s0) / riseDist);
        const approach = smoothstep((55 - relative) / 35);
        const exit = smoothstep((relative + 18) / 14);
        q += side * needed * rise * approach * exit;
      } else if (delayed && lead) {
        // Switchback waits behind the lead car and takes the opposite side only
        // after the predicted braking point, using the same body-space rule.
        const switchSide = this.selectedSide || (this._ref(encounterS, ref).q >= (lead.q ?? 0) ? 1 : -1);
        const clearance = (lead.halfWidth ?? 1.01) + 1.26;
        const needed = Math.max(0, switchSide * ((lead.q ?? 0) - nominal.q) + clearance);
        const after = smoothstep((t - encounterT + 0.4) / 0.9);
        q += switchSide * needed * after;
      }

      // Continuous multi-obstacle bypass (Section 9):
      // Static or finished cars are bypassed through one coherent corridor without stop-and-go speed matching.
      if (staticObstacles.length > 0) {
        for (const item of staticObstacles) {
          const obs = item.opp;
          const obsDs = item.ds;
          if (obsDs > -5.0 && obsDs < 65.0) {
            const obsQ = obs.q ?? 0;
            const clearMargin = (obs.halfWidth ?? 1.01) + (ego.halfWidth ?? 1.01) + 0.95;
            const passRight = obsQ + clearMargin <= legalQ - 0.2;
            const passLeft = obsQ - clearMargin >= -legalQ + 0.2;
            const chooseRight = passRight && ((ego.q ?? 0) >= obsQ || !passLeft);
            const avoidQ = chooseRight ? (obsQ + clearMargin) : (obsQ - clearMargin);
            const relativeDist = Math.abs(obsDs - (s - s0));
            if (relativeDist < 35.0) {
              const blend = smoothstep((35.0 - relativeDist) / 22.0);
              q = q + (avoidQ - q) * blend;
            }
          }
        }
      }

      // Dynamic Hazards (Section 4):
      // Rejoining cars with inward lateral drift must have their projected occupancy excluded
      if (dynamicHazards.length > 0) {
        for (const item of dynamicHazards) {
          const haz = item.opp;
          const hazV = haz.longitudinalVelocity ?? haz.speed ?? haz.v ?? v;
          const hazDq = haz.lateralVelocity ?? haz.dq ?? 0;
          const hazS = (haz.s ?? 0) + hazV * t;
          const hazQ = (haz.q ?? 0) + hazDq * t;
          const distLong = Math.abs(s - hazS);
          const bodyLong = (haz.halfLength ?? 2.325) + (ego.halfLength ?? 2.325) + 2.0;
          if (distLong < bodyLong) {
            const reqSpace = (haz.halfWidth ?? 1.01) + (ego.halfWidth ?? 1.01) + 0.85;
            if (hazQ > 0) {
              const boundary = hazQ - reqSpace;
              if (q > boundary) q = Math.max(-legalQ, boundary);
            } else {
              const boundary = hazQ + reqSpace;
              if (q < boundary) q = Math.min(legalQ, boundary);
            }
          }
        }
      }

      if (defend && topology === 'H_FOLLOW' && Math.abs(apexDeviation) >= 0.7) {
        const u = i / count;
        q += Math.sign(apexDeviation) * 0.45 * Math.sin(Math.PI * u) ** 2;
      }
      // Solid body lateral exclusion for all overlapping or adjacent vehicles
      for (const item of nearby) {
        const other = item.opp;
        const otherV = other.speed ?? other.v ?? v;
        const ds = item.ds + (otherV - v) * t;
        const bodyLong = (other.halfLength ?? 2.325) + (ego.halfLength ?? 2.325) + 0.8;
        if (Math.abs(ds) < bodyLong) {
          const sideOfOther = this.selectedSide !== 0 ? this.selectedSide :
            (Math.sign((ego.q ?? 0) - (other.q ?? 0)) || ((ego.id ?? 0) < (other.id ?? 0) ? 1 : -1));
          const required = (other.halfWidth ?? 1.01) + (ego.halfWidth ?? 1.01) + 0.70;
          if (sideOfOther > 0) {
            const boundary = (other.q ?? 0) + required;
            if (q < boundary) q = Math.min(legalQ, boundary);
          } else {
            const boundary = (other.q ?? 0) - required;
            if (q > boundary) q = Math.max(-legalQ, boundary);
          }
        }
      }
      // When trailing on a flank (gap < 18m and laterally separated), do not drift across into lead car's space
      if (lead && gap < 18 && Math.abs((ego.q ?? 0) - (lead.q ?? 0)) > 0.8) {
        const sideOfLead = (side !== 0) ? side : Math.sign((ego.q ?? 0) - (lead.q ?? 0));
        const reqClear = (lead.halfWidth ?? 1.01) + (ego.halfWidth ?? 1.01) + 0.60;
        if (sideOfLead > 0) {
          const boundary = (lead.q ?? 0) + reqClear;
          if (q < boundary) q = Math.min(legalQ, boundary);
        } else if (sideOfLead < 0) {
          const boundary = (lead.q ?? 0) - reqClear;
          if (q > boundary) q = Math.max(-legalQ, boundary);
        }
      }
      if (side || delayed || adjacent || defend || nearby.length > 0 || activeEpisode) q = clamp(q, -legalQ, legalQ);
      const qDot = (i === 0) ? egoDq : (q - nodes[i - 1].q) / Math.max(1e-4, t - nodes[i - 1].t);
      nodes.push({ s, q, qDot, v: nominal.v, t, deformation: q - nominal.q });
    }
    nodes.targetQ = nodes[Math.min(count, 2)].q;
    nodes.corridorFeasible = !side || !corridorGraph || Boolean(flank) || Boolean(activeEpisode?.ownedCorridor);
    nodes.encounterCorridor = flank ? [flank.lo, flank.hi] : (activeEpisode?.ownedCorridor ?? null);
    nodes.corridorBounds = nodes.encounterCorridor ?? [clamp(nodes.targetQ - 0.8, -legalQ, legalQ), clamp(nodes.targetQ + 0.8, -legalQ, legalQ)];
    return nodes;
  }

  _corridorGraph(ego, beliefOccupancy, ref, legalQ) {
    if (!beliefOccupancy?.freeIntervalsAt) return null;
    const speed = Math.max(5, ego.speed ?? ego.v ?? 30);
    const length = ref?.length ?? 2704.62;
    const layers = [];
    const q0 = ego.q ?? 0;
    const qDot0 = ego.lateralVelocity ?? ego.dq ?? this.egoQDot ?? 0;
    const aLatMax = Math.min(8.5, this._availableLat(speed) * 0.85);
    const dtLayer = this.horizon / 12;

    for (let i = 0; i <= 12; i++) {
      const t = dtLayer * i;
      const station = (ego.s ?? 0) + speed * t;
      // Use dominant modal branches to discover a corridor. Residual branch
      // risk is still scored separately for each full candidate trajectory.
      const intervals = beliefOccupancy.freeIntervalsAt(station, t, -legalQ, legalQ, length, 0.25)
        .map(([lo, hi]) => ({ lo, hi, center: clamp(this._ref(station, ref).q, lo, hi), reachable: false }));

      if (!this.flags?.fixA_corridorReachability) {
        // BASELINE (V4.1)
        for (const interval of intervals) {
          if (i === 0) interval.reachable = (ego.q ?? 0) >= interval.lo - 0.5 &&
            (ego.q ?? 0) <= interval.hi + 0.5;
          else interval.reachable = layers.at(-1).intervals.some(previous => previous.reachable &&
            Math.max(0, interval.lo - previous.hi, previous.lo - interval.hi) <= 4.5 * this.horizon / 12);
        }
      } else {
        // FIX A: Physical Transition Reachability
        const qReachMin = Math.max(-legalQ, q0 + qDot0 * t - 0.5 * aLatMax * t * t);
        const qReachMax = Math.min(legalQ, q0 + qDot0 * t + 0.5 * aLatMax * t * t);

        for (const interval of intervals) {
          const dynamicOverlap = Math.max(interval.lo, qReachMin) <= Math.min(interval.hi, qReachMax);
          if (!dynamicOverlap) {
            interval.reachable = false;
            continue;
          }

          if (i === 0) {
            interval.reachable = (q0 >= interval.lo - 0.35 && q0 <= interval.hi + 0.35);
          } else {
            const distFromQ0 = interval.lo > q0 ? (interval.lo - q0) : (interval.hi < q0 ? (q0 - interval.hi) : 0);
            const dir = interval.lo > q0 ? 1 : (interval.hi < q0 ? -1 : 0);
            const initV = qDot0 * dir;
            const maxShift = Math.max(0, initV * t + 0.5 * aLatMax * t * t) + 0.30;
            const reachableFromStart = (distFromQ0 <= maxShift);

            const maxStepShift = (Math.max(4.5, Math.abs(qDot0)) + aLatMax * dtLayer) * dtLayer + 0.35;
            const connectsFromPrev = layers[i - 1].intervals.some(prev => prev.reachable &&
              Math.max(0, interval.lo - prev.hi, prev.lo - interval.hi) <= maxStepShift);

            interval.reachable = connectsFromPrev || (reachableFromStart && (layers[i - 1].intervals.length > 0));
          }
        }
      }
      layers.push({ t, s: station, intervals });
    }
    return { layers };
  }

  _cost(topology, trajectory, ego, lead, gap, ref, legalQ, valueField) {
    let cost = 0;
    const v = Math.max(5, ego.speed ?? ego.v ?? 30);
    const leadV = lead ? (lead.speed ?? lead.v ?? v) : v;
    const closing = Math.max(0, v - leadV);
    let lineVariation = 0;
    for (let i = 1; i < trajectory.length; i++) {
      const p = trajectory[i];
      const prev = trajectory[i - 1];
      const deform = p.deformation;
      // Spatial loss and steering burden grow sharply in fast corners.
      const refSpeed = this._ref(p.s, ref).v;
      lineVariation += Math.abs(this._ref(p.s, ref).q - this._ref(prev.s, ref).q);
      cost += (0.012 + 0.000012 * refSpeed * refSpeed) * deform * deform;
      cost += 0.18 * (deform - prev.deformation) ** 2;
      if (Math.abs(p.q) > legalQ - 0.3) cost += 2;
      if (lead) {
        const ds = gap + (leadV - v) * p.t;
        const lat = Math.abs(p.q - (lead.q ?? 0));
        const body = (lead.halfWidth ?? 1.01) + 1.01 + 0.85;
        if (topology !== 'H_FOLLOW') {
          if (Math.abs(ds) < 5.2 && lat < body) cost += 160 * (body - lat + 0.1);
          else if (Math.abs(ds) < 10 && lat < body + 0.4) cost += 5 * (body + 0.4 - lat);
        }
      }
    }
    if (lead && topology === 'H_FOLLOW' && closing > 0.5) {
      const available = Math.max(0, gap - 5.2);
      const aBrakeMax = this._availableBrake(v, 0);
      const safeSpeed = Math.sqrt(leadV * leadV + 2 * (aBrakeMax * 0.85) * available);
      if (v > safeSpeed) cost += (v - safeSpeed) * 2.5;
    }
    if (topology !== 'H_FOLLOW') cost += 5 * Math.max(0, lineVariation - 4);
    if (valueField?.getValue) {
      const end = trajectory.at(-1);
      cost += 0.05 * valueField.getValue(end);
    }
    return cost;
  }

  _rollout(topology, trajectory, ego, lead, gap, ref) {
    const v0 = Math.max(2, ego.speed ?? ego.v ?? 30);
    const leadV = lead ? Math.max(2, lead.speed ?? lead.v ?? v0) : Infinity;
    const limits = trajectory.map((point, i) => {
      const before = trajectory[Math.max(0, i - 1)];
      const after = trajectory[Math.min(trajectory.length - 1, i + 1)];
      const ds = Math.max(1, (after.s - before.s) /
        (i > 0 && i < trajectory.length - 1 ? 2 : 1));
      const qCurvature = i > 0 && i < trajectory.length - 1 ?
        (after.q - 2 * point.q + before.q) / (ds * ds) : 0;
      const curvature = Math.abs(this._ref(point.s, ref).kappa + qCurvature);
      const latCapacity = this._availableLat(this._ref(point.s, ref).v);
      const lateralSpeed = Math.sqrt(latCapacity / Math.max(0.0008, curvature));
      let speed = Math.min(this._ref(point.s, ref).v * 1.05, lateralSpeed);
      if (lead && topology === 'H_FOLLOW') {
        const relative = gap + (leadV - v0) * point.t;
        if (relative < 12 && relative > -5.2 &&
          Math.abs(point.q - (lead.q ?? 0)) < (lead.halfWidth ?? 1.01) + 1.86) {
          speed = Math.min(speed, leadV);
        }
      }
      return { speed: Math.max(2, speed), curvature };
    });
    const speeds = limits.map(x => x.speed);
    speeds[0] = Math.min(v0, speeds[0]);
    // Backward speed propagation respecting physical braking deceleration
    for (let i = speeds.length - 2; i >= 1; i--) {
      const distance = trajectory[i + 1].s - trajectory[i].s;
      const latAccel = speeds[i + 1] ** 2 * limits[i + 1].curvature;
      const aBrake = this._availableBrake(speeds[i + 1], latAccel);
      speeds[i] = Math.min(speeds[i], Math.sqrt(speeds[i + 1] ** 2 + 2 * aBrake * distance));
    }
    // Forward acceleration propagation
    for (let i = 1; i < speeds.length; i++) {
      const distance = trajectory[i].s - trajectory[i - 1].s;
      speeds[i] = Math.min(speeds[i], Math.sqrt(speeds[i - 1] ** 2 + 10 * distance));
    }
    let duration = 0, requiredBraking = 0, maxBrakingDeficit = 0, peakGrip = 0;
    for (let i = 1; i < speeds.length; i++) {
      const distance = trajectory[i].s - trajectory[i - 1].s;
      duration += 2 * distance / Math.max(2, speeds[i] + speeds[i - 1]);
      const stepDecel = (speeds[i - 1] ** 2 - speeds[i] ** 2) / Math.max(2, 2 * distance);
      requiredBraking = Math.max(requiredBraking, stepDecel);
      const latAccel = speeds[i - 1] ** 2 * limits[i - 1].curvature;
      const availBrake = this._availableBrake(speeds[i - 1], latAccel);
      if (stepDecel > availBrake) {
        maxBrakingDeficit = Math.max(maxBrakingDeficit, stepDecel - availBrake);
      }
      peakGrip = Math.max(peakGrip, latAccel / this._availableLat(speeds[i]));
    }
    return {
      duration,
      minSpeed: Math.min(...speeds),
      exitSpeed: speeds.at(-1),
      requiredBraking,
      brakingDeficit: maxBrakingDeficit,
      peakGrip,
      terminalQ: trajectory.at(-1).q
    };
  }

  _at(trajectory, s) {
    if (s <= trajectory[0].s) return trajectory[0].q;
    for (let i = 1; i < trajectory.length; i++) {
      if (s <= trajectory[i].s) {
        const a = trajectory[i - 1], b = trajectory[i];
        return a.q + (b.q - a.q) * (s - a.s) / Math.max(1e-6, b.s - a.s);
      }
    }
    return trajectory.at(-1).q;
  }

  _sweptConflict(ego, trajectory, beliefOccupancy, ref, opponentId = null) {
    const tubes = beliefOccupancy?.latestTubes ?? [];
    const length = ref?.length ?? 2704.62;
    const speed = Math.max(0, ego.speed ?? ego.v ?? 0);
    let peakRisk = 0, firstTTC = Infinity, minClearance = Infinity;
    let conflictSpeed = Infinity;
    let culprit = null, modes = [], freeIntervals = [];
    const byOpponent = {};
    let totalPhysicalCollisionRisk = 0;

    for (const point of trajectory) {
      if (point.t < 0.2 || point.t > 2.5) continue;
      const egoS = this.flags?.fixB_consistentSweptQ ? point.s : ((ego.s ?? 0) + speed * point.t);
      const egoQ = this.flags?.fixB_consistentSweptQ ? point.q : ((ego.q ?? 0) + clamp(point.q - (ego.q ?? 0), -3.5 * point.t, 3.5 * point.t));
      for (const opponent of tubes) {
        if (opponentId !== null && opponent.id !== opponentId) continue;
        let oppTotalRisk = 0;
        let oppPhysRisk = 0;
        const riskyModes = [];
        let slowestConflict = Infinity;
        for (const branch of opponent.branches ?? []) {
          if (branch.probability < 0.05) continue;
          const segment = branch.tubes[Math.min(branch.tubes.length - 1,
            Math.round(point.t / Math.max(0.001, branch.tubes[1]?.t ?? 0.25)))];
          const ds = wrapTrack(segment.s_mean - egoS, length);
          const yawDelta = (opponent.physical?.yaw ?? 0) - (ego.yaw ?? 0);
          const orientedWidth = 1.01 * Math.abs(Math.cos(yawDelta)) +
            2.325 * Math.abs(Math.sin(yawDelta));
          const longitudinalClearance = Math.abs(ds) - (2.325 + segment.sweptBody.halfLength + 0.35);
          const physicalLateralClearance = Math.abs(egoQ - segment.q_mean) -
            (1.01 + orientedWidth + 0.20);
          const uncertaintyLateralClearance = physicalLateralClearance - (segment.sigma_q ?? 0.25);

          if (longitudinalClearance < 0) {
            minClearance = Math.min(minClearance, physicalLateralClearance);
            if (physicalLateralClearance < 0) {
              // Direct physical body collision in this predicted mode
              oppPhysRisk += branch.probability;
              oppTotalRisk += branch.probability;
              riskyModes.push(branch.mode);
              slowestConflict = Math.min(slowestConflict, segment.v);
            } else if (uncertaintyLateralClearance < 0) {
              // Uncertainty overlap without direct body collision
              oppTotalRisk += branch.probability;
              riskyModes.push(branch.mode);
              slowestConflict = Math.min(slowestConflict, segment.v);
            }
          }
        }
        totalPhysicalCollisionRisk = Math.max(totalPhysicalCollisionRisk, oppPhysRisk);
        if (oppTotalRisk > (byOpponent[opponent.id]?.peakRisk ?? 0)) {
          byOpponent[opponent.id] = {
            peakRisk: oppTotalRisk,
            physicalRisk: oppPhysRisk,
            firstTTC: point.t,
            conflictSpeed: slowestConflict,
            modes: riskyModes
          };
        }
        if (oppTotalRisk > peakRisk) {
          peakRisk = oppTotalRisk;
          culprit = opponent.id;
          modes = riskyModes;
          firstTTC = point.t;
          conflictSpeed = slowestConflict;
          freeIntervals = beliefOccupancy.freeIntervalsAt?.(egoS, point.t,
            -Math.min(6.15, (ref?.halfWidth ?? 8.2) - 1.81),
            Math.min(6.15, (ref?.halfWidth ?? 8.2) - 1.81), length, 0.08) ?? [];
        }
      }
    }
    return {
      peakRisk,
      physicalCollisionRisk: totalPhysicalCollisionRisk,
      firstTTC,
      minClearance,
      conflictSpeed,
      opponentId: culprit,
      modes,
      freeIntervals,
      byOpponent
    };
  }

  plan(ego, opponents, valueField, beliefOccupancy, ref, currentTime = 0, dt = 1 / 120) {
    const step = Number.isFinite(dt) && dt > 0 ? clamp(dt, 1 / 1000, 0.1) : 1 / 120;
    const s = ego.s ?? 0, v = Math.max(0, ego.speed ?? ego.v ?? 30), q = ego.q ?? 0;
    if (this.lastEgoQ !== null) {
      const observed = clamp((q - this.lastEgoQ) / step, -15, 15);
      this.egoQDot = 0.65 * this.egoQDot + 0.35 * observed;
    }
    this.lastEgoQ = q;
    const length = ref?.length ?? 2704.62;
    const roadHalfWidth = ref?.halfWidth ?? 8.2;
    const legalQ = Math.max(6.15, roadHalfWidth - 1.01 - 0.4);
    const egoHalfLength = ego.halfLength ?? 2.325;
    const egoHalfWidth = ego.halfWidth ?? 1.01;
    const longMargin = 0.50;
    const latMargin = 0.70;

    // 1. Update Persistent Interaction Episodes & Corridor Ownership (Section 4, 5, 6)
    const activeEpisode = this.episodeTracker.update({
      ego,
      opponents,
      currentTime,
      dt: step,
      trackLength: length,
      legalQ,
      beliefOccupancy,
      currentKappa: this._ref(s, ref).kappa
    });

    // 2. Classify Semantic Object Roles & Dynamic States (Section 3 & V4.1)
    const nearby = (opponents ?? []).map(opp => {
      const oppHalfLength = opp.halfLength ?? 2.325;
      const oppHalfWidth = opp.halfWidth ?? 1.01;
      const ds = wrapTrack((opp.s ?? 0) - s, length);
      const status = classifyCompetitor(opp, ego, ref);
      const role = classifyOpponentRole(opp, ego, ref);
      const isAhead = ds > (egoHalfLength + oppHalfLength + longMargin);
      const isBehind = ds < -(egoHalfLength + oppHalfLength + longMargin);
      const isOverlapping = !isAhead && !isBehind;
      return { opp, ds, oppHalfLength, oppHalfWidth, role, status, isAhead, isBehind, isOverlapping };
    });

    // Separate active racing competitors from static/finished obstacles and dynamic hazards
    const staticObstacles = nearby.filter(x => isObstacleRole(x.status));
    const dynamicHazards = nearby.filter(x => isDynamicHazard(x.status));
    const racingNearby = nearby.filter(x => isRacingCompetitor(x.status));

    const aheadList = racingNearby.filter(x => x.isAhead && x.ds < 65).sort((a, b) => a.ds - b.ds);
    const behindList = racingNearby.filter(x => x.isBehind && x.ds > -35).sort((a, b) => b.ds - a.ds);
    const overlappingList = racingNearby.filter(x => x.isOverlapping).sort((a, b) => Math.abs(a.ds) - Math.abs(b.ds));

    const ahead = aheadList[0] ?? null;
    const behind = behindList[0] ?? null;
    const overlap = overlappingList[0] ?? null;

    const adjacentThreats = racingNearby.filter(x => Math.abs(x.ds) < 11 &&
      Math.abs(q - (x.opp.q ?? 0)) < 4.8)
      .sort((a, b) => Math.abs(a.ds) - Math.abs(b.ds));
    const adjacent = overlap ?? adjacentThreats[0] ?? null;
    const lead = ahead?.opp ?? null;
    const gap = ahead?.ds ?? Infinity;
    const leadV = lead ? (lead.speed ?? lead.v ?? v) : v;
    const closing = v - leadV;
    const rearClosing = behind ? (behind.opp.speed ?? behind.opp.v ?? v) - v : 0;
    const defend = !lead && !overlap && behind && rearClosing > 1.5 &&
      (behind.ds > -12 || -behind.ds / rearClosing < 3);
    const previousAttackId = this.lastAttackId;

    // Persistent target & side tracking: DO NOT reset maneuver identity during overlap (Section 4)
    const isCombatEpisode = activeEpisode && (activeEpisode.hasInitiatedAttack || (activeEpisode.bodyState === RELATIVE_BODY_STATE.OVERLAPPING && activeEpisode.selectedSide !== 0)) && activeEpisode.bodyState !== RELATIVE_BODY_STATE.PASS_COMPLETE;
    const primaryCombatRivalId = isCombatEpisode
      ? activeEpisode.rivalId
      : (lead?.id ?? null);

    if (primaryCombatRivalId !== this.targetId) {
      this.targetId = primaryCombatRivalId;
      this.episodeId++;
      this.selectedSide = isCombatEpisode ? activeEpisode.selectedSide : 0;
      this.commitmentTime = 0;
      this.targetAge = 0;
      this.maneuverAge = 0;
    } else {
      this.targetAge += step;
      this.commitmentTime += step;
      this.maneuverAge += step;
      if (isCombatEpisode && activeEpisode.selectedSide !== 0) {
        this.selectedSide = activeEpisode.selectedSide;
      }
    }

    const corridorGraph = lead && gap < 65 ?
      this._corridorGraph(ego, beliefOccupancy, ref, legalQ) : null;
    const candidates = ['H_FOLLOW', 'H_OUTSIDE', 'H_INSIDE', 'H_SWITCHBACK'].map(topology => {
      const trajectory = this._trajectory(topology, ego, lead, gap, adjacent, ref, legalQ, defend, corridorGraph, nearby, activeEpisode, staticObstacles, dynamicHazards);
      const predicted = beliefOccupancy && ((lead && closing > -2.0 && gap < 45) || adjacent) ?
        this._sweptConflict(ego, trajectory, beliefOccupancy, ref) : null;
      const rollout = this._rollout(topology, trajectory, ego, lead, gap, ref);
      const heuristicCost = this._cost(topology, trajectory, ego, lead, gap, ref, legalQ, valueField);

      // Traversal time and exit speed
      let cost = 10 * rollout.duration - 0.5 * rollout.exitSpeed + 0.06 * heuristicCost;

      // Continuous risk cost across modes
      cost += 25 * (predicted?.peakRisk ?? 0);

      // Real time cost of following: being trapped behind a slower rival loses lap time
      if (topology === 'H_FOLLOW' && lead && gap < 45) {
        const refSpeed = this._ref(s, ref).v;
        const speedDeficit = Math.max(0, refSpeed - leadV);
        cost += 6.0 * (speedDeficit / Math.max(10, refSpeed)) * rollout.duration;
      }

      // Dominant physical collision (direct body overlap with rival in dominant mode >= 0.45)
      if (topology !== 'H_FOLLOW' && (predicted?.physicalCollisionRisk ?? 0) >= 0.45) {
        cost += 400;
      }

      // Corridor feasibility
      if (!trajectory.corridorFeasible) {
        cost += 200;
      }

      // Physical braking limit deficit
      if (rollout.brakingDeficit > 0.5) {
        cost += 20 * rollout.brakingDeficit;
      }

      // Lateral grip budget
      if (rollout.peakGrip > 1.05) {
        cost += 15 * (rollout.peakGrip - 1.0);
      }

      // Switchback penalty if not returning to racing line
      if (topology === 'H_SWITCHBACK' && Math.abs(trajectory.at(-1).deformation) > 0.5) {
        cost += 80;
      }

      // Commitment hysteresis: if already committed and in active overtaking battle, give persistence bonus
      const side = topology === 'H_OUTSIDE' ? 1 : topology === 'H_INSIDE' ? -1 : 0;
      if (this.selectedSide && side === this.selectedSide && gap < 30 && closing > -0.5) {
        cost -= 4.0;
      }

      return { topology, trajectory, cost, predicted, rollout, heuristicCost };
    });
    candidates.sort((a, b) => a.cost - b.cost);

    const timeToBody = closing > 0.1 ? (gap - 4.5) / closing : Infinity;
    const followCandidate = candidates.find(c => c.topology === 'H_FOLLOW');
    const attackCandidates = candidates.filter(c => c.topology !== 'H_FOLLOW' && c.topology !== 'H_SWITCHBACK' &&
      c.trajectory.corridorFeasible && (c.predicted?.physicalCollisionRisk ?? 0) < 0.45);
    const bestAttack = attackCandidates.sort((a, b) => a.cost - b.cost)[0] ?? null;

    // An attack window is viable whenever a physically feasible pass corridor exists
    // and its evaluated cost is competitive with or better than following.
    const attackReachable = gap < 30 || (gap < 45 && closing > 0.5);
    const inBattle = this.selectedSide !== 0 && this.maneuverAge < 2.5 && gap < 30 && closing > -0.5;
    const attackWindow = lead && currentTime >= this.attackCooldownUntil &&
      attackReachable && bestAttack &&
      (bestAttack.cost < followCandidate.cost + 2.0 || inBattle);

    let chosen;
    const isCommittedPass = activeEpisode && (activeEpisode.hasInitiatedAttack || this.selectedSide !== 0) &&
      (activeEpisode.bodyState === RELATIVE_BODY_STATE.OVERLAPPING || activeEpisode.bodyState === RELATIVE_BODY_STATE.CLEARING);

    if (isCommittedPass) {
      // Side-by-side corridor ownership holds committed pass topology (Section 7):
      const side = activeEpisode.selectedSide !== 0 ? activeEpisode.selectedSide : (this.selectedSide || 1);
      chosen = (side > 0 ? candidates.find(c => c.topology === 'H_OUTSIDE') : candidates.find(c => c.topology === 'H_INSIDE')) || followCandidate;
      this.phase = activeEpisode.bodyState === RELATIVE_BODY_STATE.CLEARING ? RACECRAFT_PHASE.CLEARING : RACECRAFT_PHASE.OVERLAP;
    } else if (activeEpisode && activeEpisode.bodyState === RELATIVE_BODY_STATE.PASS_COMPLETE) {
      chosen = followCandidate;
      this.phase = RACECRAFT_PHASE.PASS_COMPLETE;
      this.lastAttackId = null;
      this.selectedSide = 0;
    } else if (!lead && !behind && !overlap) {
      chosen = followCandidate;
      this.phase = RACECRAFT_PHASE.FREE;
      this.selectedSide = 0;
      this.maneuverAge = 0;
    } else if (lead && !attackWindow) {
      chosen = followCandidate;
      if (previousAttackId != null && previousAttackId === lead.id && ((gap > 8.0 && closing < -0.8) || gap > 32.0)) {
        this.abortUntil = currentTime + 0.35;
        this.attackCooldownUntil = currentTime + 0.25;
        this.lastAttackId = null;
        this.selectedSide = 0;
        this.maneuverAge = 0;
        const leadEp = this.episodeTracker.episodes.get(lead.id);
        if (leadEp) leadEp.hasInitiatedAttack = false;
      }
      this.phase = currentTime < this.abortUntil ? RACECRAFT_PHASE.ABORT :
        overlap ? RACECRAFT_PHASE.OVERLAP : RACECRAFT_PHASE.FOLLOW;
    } else if (lead) {
      chosen = (bestAttack && (bestAttack.cost < followCandidate.cost + 2.0 || inBattle)) ? bestAttack : candidates[0];
      if (chosen.topology === 'H_FOLLOW') {
        if (previousAttackId != null && previousAttackId === lead.id && ((gap > 8.0 && closing < -0.8) || gap > 32.0)) {
          this.abortUntil = currentTime + 0.35;
          this.attackCooldownUntil = currentTime + 0.25;
          this.lastAttackId = null;
          this.selectedSide = 0;
          this.maneuverAge = 0;
          const leadEp = this.episodeTracker.episodes.get(lead.id);
          if (leadEp) leadEp.hasInitiatedAttack = false;
        }
        this.phase = currentTime < this.abortUntil ? RACECRAFT_PHASE.ABORT :
          overlap ? RACECRAFT_PHASE.OVERLAP : RACECRAFT_PHASE.FOLLOW;
      } else {
        const newSide = chosen.topology === 'H_OUTSIDE' ? 1 : chosen.topology === 'H_INSIDE' ? -1 : this.selectedSide;
        if (newSide !== this.selectedSide || this.phase === RACECRAFT_PHASE.FOLLOW || this.phase === RACECRAFT_PHASE.ABORT) {
          this.maneuverAge = 0;
        }
        this.selectedSide = newSide;
        if (activeEpisode) {
          activeEpisode.selectedSide = newSide;
          activeEpisode.hasInitiatedAttack = true;
          activeEpisode.attackPhase = ATTACK_PHASE.COMMITTED;
        } else {
          const leadEp = this.episodeTracker.episodes.get(lead.id);
          if (leadEp) {
            leadEp.selectedSide = newSide;
            leadEp.hasInitiatedAttack = true;
            leadEp.attackPhase = ATTACK_PHASE.COMMITTED;
          }
        }
        this.phase = gap < 5.2 ? RACECRAFT_PHASE.PRE_OVERLAP : RACECRAFT_PHASE.ATTACK_COMMITTED;
        this.lastAttackId = lead.id;
      }
    } else if (overlap) {
      const side = this.selectedSide !== 0 ? this.selectedSide : (Math.sign(q - (overlap.opp.q ?? 0)) || 1);
      chosen = (side > 0 ? candidates.find(c => c.topology === 'H_OUTSIDE') : candidates.find(c => c.topology === 'H_INSIDE')) || followCandidate;
      this.phase = (overlap.ds < 0) ? RACECRAFT_PHASE.CLEARING : RACECRAFT_PHASE.OVERLAP;
    } else {
      chosen = followCandidate;
      this.phase = defend ? RACECRAFT_PHASE.DEFEND_COMMITTED : RACECRAFT_PHASE.CLEARING;
      const passed = (previousAttackId != null) ? nearby.find(x => x.opp.id === previousAttackId) : null;
      if (passed) {
        const rearClearance = egoHalfLength + passed.oppHalfLength + 1.5;
        const freeExit = beliefOccupancy?.freeIntervalsAt?.(
          s + v * 0.5, 0.5, -legalQ, legalQ, length) ?? [[-legalQ, legalQ]];
        const exitQ = this._ref(s + v * 0.5, ref).q;
        if (passed.ds < -rearClearance && freeExit.some(([lo, hi]) => exitQ >= lo && exitQ <= hi)) {
          this.phase = RACECRAFT_PHASE.PASS_COMPLETE;
          this.lastAttackId = null;
          this.selectedSide = 0;
        }
      }
    }

    const targetTrajectory = chosen.trajectory;
    const targetQAt = station => {
      let qVal = this._at(targetTrajectory, station);

      // Enforce corridor ownership bounds across active combat episode (Section 6)
      if (activeEpisode && (activeEpisode.bodyState === 'OVERLAPPING' || activeEpisode.bodyState === 'CLEARING' || activeEpisode.bodyState === 'PRE_OVERLAP')) {
        const side = activeEpisode.selectedSide !== 0 ? activeEpisode.selectedSide : this.selectedSide;
        if (side < 0 && activeEpisode.ownedCorridor) {
          if (qVal > activeEpisode.ownedCorridor[1]) qVal = activeEpisode.ownedCorridor[1];
        } else if (side > 0 && activeEpisode.ownedCorridor) {
          if (qVal < activeEpisode.ownedCorridor[0]) qVal = activeEpisode.ownedCorridor[0];
        }
      }

      if (overlap || this.phase === RACECRAFT_PHASE.OVERLAP || this.phase === RACECRAFT_PHASE.CLEARING || this.phase === RACECRAFT_PHASE.ABORT) {
        const activeRival = overlap?.opp ?? ((previousAttackId != null) ? nearby.find(x => x.opp.id === previousAttackId)?.opp : null) ?? null;
        if (activeRival) {
          const rivalS = activeRival.s ?? activeRival.station ?? s;
          const dsStation = Math.abs(wrapTrack(station - rivalS, length));
          // FIX (Section 2): Dimensionally correct longitudinal body length (egoHalfLength, NOT egoHalfWidth)
          const bodyLong = (activeRival.halfLength ?? 2.325) + egoHalfLength + 0.8;
          if (dsStation < bodyLong + 8.0) {
            const taper = dsStation <= bodyLong ? 1.0 : smoothstep((bodyLong + 8.0 - dsStation) / 8.0);
            const side = this.selectedSide !== 0 ? this.selectedSide : (Math.sign(q - (activeRival.q ?? 0)) || 1);
            const reqSpace = (activeRival.halfWidth ?? 1.01) + egoHalfWidth + latMargin;
            if (side > 0) {
              const boundary = (activeRival.q ?? 0) + reqSpace;
              const minSafe = qVal + (boundary - qVal) * taper;
              if (qVal < minSafe) qVal = Math.min(legalQ, minSafe);
            } else {
              const boundary = (activeRival.q ?? 0) - reqSpace;
              const maxSafe = qVal + (boundary - qVal) * taper;
              if (qVal > maxSafe) qVal = Math.max(-legalQ, maxSafe);
            }
          }
        }
      }
      if ((this.phase === RACECRAFT_PHASE.PRE_OVERLAP || this.phase === RACECRAFT_PHASE.ATTACK_COMMITTED) &&
          lead && gap < 12 && Math.abs(q - (lead.q ?? 0)) > 0.8) {
        const sideOfLead = (this.selectedSide !== 0) ? this.selectedSide : Math.sign(q - (lead.q ?? 0));
        const reqClear = (lead.halfWidth ?? 1.01) + egoHalfWidth + 0.60;
        if (sideOfLead > 0 && (lead.q ?? 0) + reqClear <= legalQ - 0.3) {
          const minSafe = (lead.q ?? 0) + reqClear;
          if (qVal < minSafe) qVal = minSafe;
        } else if (sideOfLead < 0 && (lead.q ?? 0) - reqClear >= -legalQ + 0.3) {
          const maxSafe = (lead.q ?? 0) - reqClear;
          if (qVal > maxSafe) qVal = maxSafe;
        }
      }
      return qVal;
    };
    const look = clamp(v * 0.54, 8.5, 26);
    this.targetQ = targetQAt(s + look);

    this.currentTopology = this.phase === RACECRAFT_PHASE.FREE ? 'FREE_AIR' : chosen.topology;

    // Braking speed caps: strictly based on true physical stopping distance
    this.targetSpeedCap = Infinity;
    let targetSpeedCapReason = null;

    // 1. LEAD_BODY_CONFLICT (Adaptive physical braking model for direct lead)
    const bumperGap = lead ? Math.max(0, gap - egoHalfLength - (lead.halfLength ?? 2.325)) : Infinity;
    if (lead && closing > 0 && gap < 50) {
      const encounterT = clamp(timeToBody, 0, this.horizon);
      const futureQ = targetQAt(s + v * encounterT);
      const bodyWidth = (lead.halfWidth ?? 1.01) + egoHalfWidth + 0.45;
      const ownQ = q + clamp(futureQ - q, -Math.max(0, encounterT) * 3.5, Math.max(0, encounterT) * 3.5);

      let pathBlocked = false;
      if (!this.flags?.fixC_closeFollowGapLaw) {
        const isImminentTailgate = bumperGap < 1.8 && (Math.abs(this.targetQ - (lead.q ?? 0)) < bodyWidth || Math.abs(q - (lead.q ?? 0)) < bodyWidth);
        pathBlocked = (chosen.topology === 'H_FOLLOW' && Math.abs(ownQ - (lead.q ?? 0)) < bodyWidth) || isImminentTailgate;
      } else {
        // Fix C: Attack corridor authority over follow caps
        const isCommittedAttack = chosen.topology !== 'H_FOLLOW' || Boolean(activeEpisode?.hasInitiatedAttack);
        const lateralClearanceAtEncounter = Math.abs(ownQ - (lead.q ?? 0));
        const hasClearanceAtEncounter = isCommittedAttack && lateralClearanceAtEncounter >= bodyWidth;

        const isImminentTailgate = !hasClearanceAtEncounter && bumperGap < 1.2 &&
          (Math.abs(this.targetQ - (lead.q ?? 0)) < bodyWidth || Math.abs(q - (lead.q ?? 0)) < bodyWidth);
        pathBlocked = !hasClearanceAtEncounter &&
          ((chosen.topology === 'H_FOLLOW' && Math.abs(ownQ - (lead.q ?? 0)) < bodyWidth) || isImminentTailgate);
      }

      if (pathBlocked && timeToBody < 3.2) {
        const currentKappa = Math.abs(this._ref(s, ref).kappa);
        const aBrakeMax = this._availableBrake(v, v * v * currentKappa);
        const aBrakeEff = Math.max(9.0, aBrakeMax * 0.88);
        const brakingDistance = Math.max(0, bumperGap - 1.2 - v * 0.08);
        const safeSpeed = Math.sqrt(leadV * leadV + 2 * aBrakeEff * brakingDistance);
        const inCap = this.lastSpeedCapReason === 'LEAD_BODY_CONFLICT';
        if (v > safeSpeed || (inCap && v > safeSpeed - 0.8)) {
          this.targetSpeedCap = Math.max(leadV, safeSpeed);
          targetSpeedCapReason = 'LEAD_BODY_CONFLICT';
        }
      }
    }

    // 2. CLOSE_FOLLOW: only when directly behind in same lane
    if (!this.flags?.fixC_closeFollowGapLaw) {
      if (lead && chosen.topology === 'H_FOLLOW' && bumperGap < 1.8 &&
          Math.abs(q - (lead.q ?? 0)) < 2.2 &&
          Math.abs(targetQAt(s + look) - (lead.q ?? 0)) < 2.2) {
        this.targetSpeedCap = Math.min(this.targetSpeedCap, Math.max(2, leadV - 0.5));
        targetSpeedCapReason = 'CLOSE_FOLLOW';
      }
    } else {
      // Fix C: Continuous relative-gap law
      const isCommittedAttack = chosen.topology !== 'H_FOLLOW' || Boolean(activeEpisode?.hasInitiatedAttack);
      if (lead && !isCommittedAttack && chosen.topology === 'H_FOLLOW' && bumperGap < 2.5 &&
          Math.abs(q - (lead.q ?? 0)) < 2.0 &&
          Math.abs(targetQAt(s + look) - (lead.q ?? 0)) < 2.0) {
        const desiredGap = clamp(v * 0.035, 1.2, 2.2);
        const gapDeficit = desiredGap - bumperGap;
        if (gapDeficit > 0 && closing > 0.05) {
          const aBrakeSafe = Math.max(6.0, this._availableBrake(v, 0) * 0.75);
          const safeSpeed = Math.sqrt(leadV * leadV + 2 * aBrakeSafe * Math.max(0, bumperGap - 0.5));
          const targetV = Math.max(leadV, safeSpeed);
          if (targetV < this.targetSpeedCap) {
            this.targetSpeedCap = targetV;
            targetSpeedCapReason = 'CLOSE_FOLLOW';
          }
        }
      }
    }

    // 3. High-speed swept conflict yield (Section 8: Remove automatic speed matching during valid overlap)
    const sweptPrediction = this._sweptConflict(ego, targetTrajectory, beliefOccupancy, ref);
    const leadRisk = (lead && lead.id != null) ? sweptPrediction.byOpponent[lead.id] : null;
    if (lead && chosen.topology === 'H_FOLLOW' &&
        v > 20 && closing > 2 && gap < 25 &&
        leadRisk?.physicalRisk >= 0.4 && leadRisk.firstTTC <= 1.6 &&
        v > leadRisk.conflictSpeed + 1) {
      this.targetSpeedCap = Math.min(this.targetSpeedCap,
        Math.max(2, leadRisk.conflictSpeed + 1));
      targetSpeedCapReason = 'PREDICTED_LEAD_BRAKING';
    }
    for (const threat of adjacentThreats) {
      const adjacentRisk = (threat.opp.id != null) ? sweptPrediction.byOpponent[threat.opp.id] : null;
      if (!(v > 12 && adjacentRisk?.peakRisk >= 0.18 &&
          adjacentRisk.firstTTC <= 1.8)) continue;
      const otherV = threat.opp.speed ?? threat.opp.v ?? v;

      // Check if lateral corridors are dynamically disjoint (not converging into each other)
      const relativeQ = (threat.opp.q ?? 0) - q;
      const threatDq = threat.opp.lateralVelocity ?? threat.opp.dq ?? threat.opp.qDot ?? 0;
      const egoDq = ego.lateralVelocity ?? ego.dq ?? this.egoQDot ?? 0;
      const closingLateralRate = (egoDq - threatDq) * Math.sign(relativeQ);
      const isLaterallyConverging = closingLateralRate > 0.15 || (relativeQ * threatDq < -0.2);

      const isCorridorDisjoint = !isLaterallyConverging && (
        activeEpisode?.isCorridorDisjoint(q, threat.opp.q) ??
        (Math.abs(relativeQ) >= (egoHalfWidth + threat.oppHalfWidth + 0.60))
      );

      if (isCorridorDisjoint) {
        // Disjoint non-overlapping lateral corridors: maintain physical racing trajectory, DO NOT SPEED MATCH!
        continue;
      }

      if (otherV > v + 0.5) {
        // Minimum longitudinal intervention needed to clear swept body overlap
        const ttc = Math.max(0.35, adjacentRisk.firstTTC ?? 1.0);
        const egoHalfL = ego.halfLength ?? 2.325;
        const oppHalfL = threat.opp.halfLength ?? 2.325;
        const longitudinalOverlap = Math.max(0.2, (egoHalfL + oppHalfL + 0.6) - Math.abs(threat.ds));
        const deltaVRequired = clamp(longitudinalOverlap / ttc, 0.4, 2.5);
        const newCap = Math.max(2, otherV - deltaVRequired);
        if (newCap < this.targetSpeedCap) {
          this.targetSpeedCap = newCap;
          if (targetSpeedCapReason !== 'PREDICTED_LEAD_BRAKING') {
            targetSpeedCapReason = 'PREDICTED_SWEPT_CONFLICT';
          }
        }
        if (!lead) this.phase = RACECRAFT_PHASE.CONCEDE;
      } else if (adjacentRisk?.physicalRisk >= 0.45 && threat.ds > -1.5) {
        // Imminent direct physical collision where lateral steering cannot prevent contact in time
        const safeCap = Math.max(8, otherV);
        if (v > safeCap && safeCap < this.targetSpeedCap) {
          this.targetSpeedCap = safeCap;
          if (targetSpeedCapReason !== 'PREDICTED_LEAD_BRAKING') {
            targetSpeedCapReason = 'PREDICTED_SWEPT_CONFLICT';
          }
        }
      }
    }

    // Dynamic hazards conflict check (Section 4)
    if (dynamicHazards.length > 0) {
      for (const hazard of dynamicHazards) {
        const hazId = hazard.opp.id;
        const hazRisk = (hazId != null) ? sweptPrediction.byOpponent[hazId] : null;
        if (hazRisk && hazRisk.firstTTC <= 2.2 && hazRisk.physicalRisk >= 0.25) {
          const hazV = hazard.opp.longitudinalVelocity ?? hazard.opp.speed ?? hazard.opp.v ?? v;
          const safeCap = Math.max(12, hazV);
          if (v > safeCap && safeCap < this.targetSpeedCap) {
            this.targetSpeedCap = safeCap;
            targetSpeedCapReason = 'DYNAMIC_HAZARD_AVOIDANCE';
          }
        }
      }
    }

    // Multi-Obstacle & Road Blockage Verification (Section 5)
    if (staticObstacles.length > 0) {
      const obstaclesAhead = staticObstacles.filter(o => o.ds > 0 && o.ds < 75.0).sort((a, b) => a.ds - b.ds);
      if (obstaclesAhead.length > 0) {
        let roadIsGenuinelyBlocked = false;
        let blockingDistance = Infinity;

        // Check each station slice ahead for whether any feasible corridor exists
        for (const obsItem of obstaclesAhead) {
          const obs = obsItem.opp;
          const obsQ = obs.q ?? 0;
          const obsWidthReq = (obs.halfWidth ?? 1.01) + egoHalfWidth + 0.35;
          const leftPassWidth = (obsQ - obsWidthReq) - (-legalQ);
          const rightPassWidth = legalQ - (obsQ + obsWidthReq);
          const minReqPassWidth = 2 * egoHalfWidth + 0.25;

          const isLeftOpen = leftPassWidth >= minReqPassWidth;
          const isRightOpen = rightPassWidth >= minReqPassWidth;

          if (!isLeftOpen && !isRightOpen) {
            // This obstacle alone blocks both flanks!
            roadIsGenuinelyBlocked = true;
            blockingDistance = Math.min(blockingDistance, obsItem.ds);
          }
        }

        // Also check staggered overlapping obstacles that together wall off the circuit
        if (!roadIsGenuinelyBlocked && obstaclesAhead.length >= 2) {
          for (let i = 0; i < obstaclesAhead.length - 1; i++) {
            const o1 = obstaclesAhead[i];
            const o2 = obstaclesAhead[i + 1];
            if (Math.abs(o1.ds - o2.ds) < 18.0) {
              const q1 = o1.opp.q ?? 0;
              const q2 = o2.opp.q ?? 0;
              const w1 = (o1.opp.halfWidth ?? 1.01) + egoHalfWidth + 0.30;
              const w2 = (o2.opp.halfWidth ?? 1.01) + egoHalfWidth + 0.30;
              const spanLeft = Math.min(q1 - w1, q2 - w2);
              const spanRight = Math.max(q1 + w1, q2 + w2);
              const leftOpen = (spanLeft - (-legalQ)) >= 2 * egoHalfWidth + 0.25;
              const rightOpen = (legalQ - spanRight) >= 2 * egoHalfWidth + 0.25;
              const gapBetween = Math.abs(q1 - q2) - (w1 + w2);
              if (!leftOpen && !rightOpen && gapBetween < 2 * egoHalfWidth + 0.25) {
                roadIsGenuinelyBlocked = true;
                blockingDistance = Math.min(blockingDistance, o1.ds);
              }
            }
          }
        }

        if (roadIsGenuinelyBlocked) {
          // Genuinely blocked: NOVA MUST BRAKE
          const aBrakeMax = this._availableBrake(v, 0);
          const aBrakeEff = Math.max(9.0, aBrakeMax * 0.88);
          const bumperGap = Math.max(0, blockingDistance - egoHalfLength - 2.5);
          const safeSpeed = Math.sqrt(2 * aBrakeEff * bumperGap);
          if (safeSpeed < this.targetSpeedCap) {
            this.targetSpeedCap = safeSpeed;
            targetSpeedCapReason = 'OBSTACLES_BLOCKING_TRACK';
          }
        }
      }
    }

    // 4. Edge crossing recovery
    const projectedQ = q + this.egoQDot * 0.45;
    const isClearingEdge = this.phase === RACECRAFT_PHASE.CLEARING && Math.abs(q) > 2.5 &&
        Math.sign(this.egoQDot) === Math.sign(q) && Math.abs(projectedQ) > legalQ + 0.35 && v > 14;
    const isImminentRunoff = Math.abs(q) > roadHalfWidth - 0.35 &&
        Math.sign(this.egoQDot) === Math.sign(q) && Math.abs(projectedQ) > roadHalfWidth + 0.25 && v > 12;
    if (isClearingEdge || isImminentRunoff) {
      const deltaRunoff = Math.abs(projectedQ) - roadHalfWidth;
      const speedTrim = clamp(deltaRunoff * 3.5, 0.5, 2.5);
      this.targetSpeedCap = Math.min(this.targetSpeedCap, Math.max(14, v - speedTrim));
      targetSpeedCapReason = 'PREDICTED_EDGE_CROSSING';
    }

    this.lastSpeedCapReason = targetSpeedCapReason;
    this.selectedCorridor = activeEpisode?.ownedCorridor ??
      [clamp(this.targetQ - 0.8, -legalQ, legalQ), clamp(this.targetQ + 0.8, -legalQ, legalQ)];
    this.corridorBounds = activeEpisode?.ownedCorridor ?? (targetTrajectory?.encounterCorridor ?? this.selectedCorridor);
    return {
      activeTopology: this.currentTopology,
      phase: this.phase,
      targetTrajectory,
      targetQAt,
      targetQ: this.targetQ,
      selectedCorridor: this.selectedCorridor,
      corridorBounds: this.corridorBounds,
      targetSpeedCap: this.targetSpeedCap,
      targetSpeedCapReason,
      sweptPrediction,
      projectedQ,
      corridorGraph,
      candidates,
      planningDt: step,
      clearanceMetrics: { minClearance: lead ? Math.abs(q - (lead.q ?? 0)) : Infinity,
        timeToBody, relativeSpeed: closing }
    };
  }
}

export function createTopologyPlanner(config) {
  return new NovaTopologyPlanner(config);
}
