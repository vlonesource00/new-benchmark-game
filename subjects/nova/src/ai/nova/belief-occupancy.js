/**
 * NovaBeliefEngine — Opponent Physical-State Estimation & Latent Intent Posterior
 * 
 * Wave R1 Architecture:
 * 1. Explicit physical state tracking (s_j, q_j, v_j, qDot_j, vDot_j) with separate
 *    filtered kinematics and physical uncertainty (sigma_s, sigma_q).
 * 2. 7-Mode Latent Intent Posterior:
 *    - HOLD
 *    - ATTACK
 *    - DEFEND_LEFT
 *    - DEFEND_RIGHT
 *    - BRAKE_EARLY
 *    - BRAKE_NORMAL
 *    - RETURN_TO_LINE
 * 3. Dirichlet / Bayesian evidence update with smooth learning rates to prevent
 *    frame-to-frame chattering while reacting decisively to genuine tactical moves.
 * 4. Causal Multimodal Space-Time Occupancy Tubes O_j(s, q, t) generated fresh
 *    every planning cycle.
 */

export const INTENT_MODES = Object.freeze([
  'HOLD',
  'ATTACK',
  'DEFEND_LEFT',
  'DEFEND_RIGHT',
  'BRAKE_EARLY',
  'BRAKE_NORMAL',
  'RETURN_TO_LINE'
]);

export const DEFAULT_PRIOR = Object.freeze({
  HOLD: 0.34,
  ATTACK: 0.16,
  DEFEND_LEFT: 0.10,
  DEFEND_RIGHT: 0.10,
  BRAKE_EARLY: 0.10,
  BRAKE_NORMAL: 0.10,
  RETURN_TO_LINE: 0.10
});

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export class NovaBeliefEngine {
  constructor(options = {}) {
    this.options = options;
    this.carLength = options.carLength || 4.65;
    this.carWidth = options.carWidth || 2.02;
    this.safetyMargin = options.safetyMargin || 0.40;

    // Physical state estimates per opponent ID
    this.physicalStates = new Map();
    // Latent intent posterior per opponent ID
    this.beliefs = new Map();
    // Space-time occupancy tubes
    this.latestTubes = [];
    this.latestOpponents = [];
  }

  /**
   * Initializes or gets the physical state tracker for an opponent
   */
  _getOrCreatePhysicalState(opp) {
    const id = opp.id;
    if (!this.physicalStates.has(id)) {
      const s = Number.isFinite(opp.s) ? opp.s : 0;
      const q = Number.isFinite(opp.q) ? opp.q : 0;
      const v = Number.isFinite(opp.v) ? opp.v : (Number.isFinite(opp.speed) ? opp.speed : 0);
      this.physicalStates.set(id, {
        id,
        s,
        q,
        v,
        yaw: Number.isFinite(opp.yaw) ? opp.yaw : 0,
        qDot: opp.dq || 0,
        vDot: opp.dv || 0,
        lastTime: null,
        sigma_s0: 0.25,
        sigma_sv: 0.60,
        sigma_q0: 0.12,
        sigma_qv: 0.18
      });
    }
    return this.physicalStates.get(id);
  }

  /**
   * Initializes or gets the 7-mode intent posterior
   */
  _getOrCreateBelief(oppId) {
    if (!this.beliefs.has(oppId)) {
      const b = { ...DEFAULT_PRIOR };
      // Legacy property aliases for 100% backward compatibility
      Object.defineProperties(b, {
        hold: { get() { return this.HOLD; }, set(v) { this.HOLD = v; }, enumerable: false },
        defendInside: { get() { return this.DEFEND_LEFT; }, set(v) { this.DEFEND_LEFT = v; }, enumerable: false },
        defendOutside: { get() { return this.DEFEND_RIGHT; }, set(v) { this.DEFEND_RIGHT = v; }, enumerable: false },
        brakeEarly: { get() { return this.BRAKE_EARLY; }, set(v) { this.BRAKE_EARLY = v; }, enumerable: false },
        attack: { get() { return this.ATTACK; }, set(v) { this.ATTACK = v; }, enumerable: false },
        brakeNormal: { get() { return this.BRAKE_NORMAL; }, set(v) { this.BRAKE_NORMAL = v; }, enumerable: false },
        returnToLine: { get() { return this.RETURN_TO_LINE; }, set(v) { this.RETURN_TO_LINE = v; }, enumerable: false }
      });
      this.beliefs.set(oppId, b);
    }
    return this.beliefs.get(oppId);
  }

  /**
   * Updates physical states and latent intent posteriors for all observed opponents
   */
  update(opponents = [], ego = {}, dt = 1 / 60) {
    const validDt = clamp(Number.isFinite(dt) && dt > 0 ? dt : 1 / 60, 0.001, 0.5);
    this.latestOpponents = opponents;

    for (const opp of opponents) {
      if (!opp || opp.id == null) continue;
      const id = opp.id;

      const pState = this._getOrCreatePhysicalState(opp);
      const belief = this._getOrCreateBelief(id);

      const rawS = Number.isFinite(opp.s) ? opp.s : pState.s;
      const rawQ = Number.isFinite(opp.q) ? opp.q : (Number.isFinite(opp.lateral) ? opp.lateral : pState.q);
      const rawV = Number.isFinite(opp.v) ? opp.v : (Number.isFinite(opp.speed) ? opp.speed : pState.v);

      // Estimate derivatives: use direct sensor if available, else causal finite differences
      let measQDot = 0;
      let measVDot = 0;

      if (Number.isFinite(opp.dq)) {
        measQDot = opp.dq;
      } else if (Number.isFinite(opp.lateralVelocity)) {
        measQDot = opp.lateralVelocity;
      } else {
        measQDot = (rawQ - pState.q) / validDt;
      }

      if (Number.isFinite(opp.dv)) {
        measVDot = opp.dv;
      } else {
        measVDot = (rawV - pState.v) / validDt;
      }

      // Alpha-beta filter to eliminate sensor jitter without phase delay
      const alphaQ = clamp(validDt / 0.12, 0.15, 0.85);
      const alphaV = clamp(validDt / 0.15, 0.15, 0.85);

      pState.qDot = (1 - alphaQ) * pState.qDot + alphaQ * measQDot;
      pState.vDot = (1 - alphaV) * pState.vDot + alphaV * measVDot;
      pState.s = rawS;
      pState.q = rawQ;
      pState.v = rawV;
      if (Number.isFinite(opp.yaw)) pState.yaw = opp.yaw;

      // Update internal fields for tube generation
      opp._s = pState.s;
      opp._q = pState.q;
      opp._v = pState.v;
      opp._qDot = pState.qDot;
      opp._vDot = pState.vDot;

      // 2. Formulate 7-mode likelihood evidence vector L(m)
      const L = {
        HOLD: 1.0,
        ATTACK: 1.0,
        DEFEND_LEFT: 1.0,
        DEFEND_RIGHT: 1.0,
        BRAKE_EARLY: 1.0,
        BRAKE_NORMAL: 1.0,
        RETURN_TO_LINE: 1.0
      };

      const qDot = pState.qDot;
      const vDot = pState.vDot;

      // Lateral motion evidence
      if (qDot < -0.15) {
        const intensity = Math.min(3.5, -qDot * 8.0);
        L.DEFEND_LEFT *= (1.0 + intensity);
        L.HOLD *= 0.65;
        L.DEFEND_RIGHT *= 0.35;
      } else if (qDot > 0.15) {
        const intensity = Math.min(3.5, qDot * 8.0);
        L.DEFEND_RIGHT *= (1.0 + intensity);
        L.HOLD *= 0.65;
        L.DEFEND_LEFT *= 0.35;
      } else {
        // Holding steady lateral position
        L.HOLD *= 1.45;
        L.DEFEND_LEFT *= 0.85;
        L.DEFEND_RIGHT *= 0.85;
      }

      // Return to racing line evidence (moving back toward track centerline / ref line)
      if (Math.abs(pState.q) > 1.2 && Math.sign(qDot) !== Math.sign(pState.q)) {
        L.RETURN_TO_LINE *= 1.8;
      } else {
        L.RETURN_TO_LINE *= 0.9;
      }

      // Longitudinal braking evidence
      if (vDot < -2.0) {
        const brakeIntensity = Math.min(4.0, -vDot * 0.75);
        L.BRAKE_EARLY *= (1.0 + brakeIntensity);
        L.BRAKE_NORMAL *= 0.6;
        L.ATTACK *= 0.5;
      } else if (vDot >= -0.5) {
        L.BRAKE_NORMAL *= 1.25;
        L.BRAKE_EARLY *= 0.75;
      }

      // Attack evidence relative to ego vehicle
      const egoS = ego.s ?? 0;
      const egoV = ego.speed ?? ego.v ?? 30;
      const dsToEgo = egoS - pState.s; // positive if rival is behind ego

      if (dsToEgo > 0 && dsToEgo < 35 && pState.v > egoV + 0.5) {
        // Rival is closing rapidly from behind
        L.ATTACK *= 2.2;
        L.HOLD *= 0.8;
      }

      // 3. Dirichlet / Bayesian Update with Non-Chattering Inertia
      // Learning rate eta controls rate of belief shift (smooth continuous posterior)
      const eta = clamp(validDt / 0.20, 0.05, 0.25);

      // Compute raw Bayes numerator
      let normSum = 0;
      const unnorm = {};
      for (const m of INTENT_MODES) {
        unnorm[m] = belief[m] * L[m];
        normSum += unnorm[m];
      }

      const invNorm = normSum > 1e-9 ? 1.0 / normSum : 1.0 / INTENT_MODES.length;
      for (const m of INTENT_MODES) {
        const pTarget = unnorm[m] * invNorm;
        belief[m] = (1.0 - eta) * belief[m] + eta * pTarget;
      }

      // Evidence-based forgetting and prior floor (prevents pathological multi-lap degeneration)
      const lambdaForget = clamp(validDt * 0.04, 0.0001, 0.01);
      const MIN_PRIOR_FLOOR = 0.035;
      for (const m of INTENT_MODES) {
        belief[m] = (1.0 - lambdaForget) * belief[m] + lambdaForget * DEFAULT_PRIOR[m];
        belief[m] = Math.max(MIN_PRIOR_FLOOR, belief[m]);
      }

      // Final normalization pass
      let finalSum = 0;
      for (const m of INTENT_MODES) finalSum += belief[m];
      const invFinal = finalSum > 1e-9 ? 1.0 / finalSum : 1.0 / INTENT_MODES.length;
      for (const m of INTENT_MODES) belief[m] *= invFinal;
    }

    // 4. Immediately produce live causal space-time occupancy tubes
    this.latestTubes = this.getOccupancyTubes(3.0, 0.25);
    return this.latestTubes;
  }

  /**
   * Returns current latent intent posterior for a car
   */
  getBelief(carId) {
    return this.beliefs.get(carId) || null;
  }

  /**
   * Returns estimated physical Frenet state (s, q, v, qDot, vDot) for a car
   */
  getPhysicalState(carId) {
    return this.physicalStates.get(carId) || null;
  }

  /**
   * Generates multimodal space-time occupancy tubes over horizon
   */
  getOccupancyTubes(horizonS = 3.0, dtStep = 0.25) {
    const tubes = [];
    const tSteps = Math.floor(horizonS / dtStep);

    if (!this.latestOpponents || this.latestOpponents.length === 0) {
      return tubes;
    }

    for (const opp of this.latestOpponents) {
      const pState = this._getOrCreatePhysicalState(opp);
      const b = this._getOrCreateBelief(opp.id);
      const halfLength = this.carLength / 2;
      const halfWidth = (this.carWidth / 2) + this.safetyMargin;
      const branches = INTENT_MODES.map(mode => {
        const probability = b[mode];
        const segments = [];
        for (let step = 0; step <= tSteps; step++) {
          const t = step * dtStep;
          const observedVdot = clamp(pState.vDot, -7, 3);
          const acceleration = mode === 'BRAKE_EARLY' ? Math.min(-3.5, observedVdot) :
            mode === 'BRAKE_NORMAL' ? Math.min(-1, observedVdot) : observedVdot;
          const v = Math.max(2, pState.v + acceleration * t);
          const s = pState.s + pState.v * t + 0.5 * acceleration * t * t;
          const lateralVelocity = clamp(pState.qDot, -3.5, 3.5);
          const settledMotion = lateralVelocity * Math.min(t, 0.7);
          const intentBlend = (() => {
            const u = clamp(t / 1.2, 0, 1);
            return u * u * (3 - 2 * u);
          })();
          let intentShift = 0;
          if (mode === 'DEFEND_LEFT') intentShift = -1.5 * intentBlend;
          else if (mode === 'DEFEND_RIGHT') intentShift = 1.5 * intentBlend;
          else if (mode === 'ATTACK') intentShift = (lateralVelocity < -0.2 ? -1 : 1) * 1.8 * intentBlend;
          else if (mode === 'RETURN_TO_LINE') intentShift = -pState.q * 0.6 * intentBlend;
          const q = pState.q + settledMotion + intentShift;
          const sigma_s = pState.sigma_s0 + pState.sigma_sv * t;
          const sigma_q = pState.sigma_q0 + pState.sigma_qv * t;
          segments.push({ t, s_mean: s, q_mean: q, v,
            s_min: s - halfLength - sigma_s, s_max: s + halfLength + sigma_s,
            q_min: q - halfWidth - sigma_q, q_max: q + halfWidth + sigma_q,
            sigma_s, sigma_q, sweptBody: { halfLength, halfWidth },
            mode, probability });
        }
        return { mode, probability, tubes: segments };
      });
      tubes.push({ id: opp.id, branches,
        // A stable legacy view for diagnostics that expect one tube per rival.
        tubes: branches.find(branch => branch.mode === 'HOLD').tubes,
        physical: { ...pState } });
    }

    this.latestTubes = tubes;
    return tubes;
  }

  /**
   * Spatio-temporal occupancy test
   */
  isOccupied(s, q, t) {
    if (!this.latestTubes || this.latestTubes.length === 0) return false;

    for (const opp of this.latestTubes) for (const branch of opp.branches ?? [{ probability: 1, tubes: opp.tubes }]) {
      if (branch.probability < 0.05) continue;
      let closestSegment = null;
      let minDiff = Infinity;

      for (const seg of branch.tubes) {
        const diff = Math.abs(seg.t - t);
        if (diff < minDiff) {
          minDiff = diff;
          closestSegment = seg;
        }
      }

      if (closestSegment && minDiff <= 0.15) {
        if (s >= closestSegment.s_min && s <= closestSegment.s_max &&
            q >= closestSegment.q_min && q <= closestSegment.q_max) {
          return true;
        }
      }
    }
    return false;
  }

  /** Legal lateral intervals after subtracting plausible swept rival bodies at one time. */
  freeIntervalsAt(s, t, qMinLegal, qMaxLegal, trackLength = null, minProbability = 0.08) {
    const blocked = [];
    for (const opp of this.latestTubes) for (const branch of opp.branches ?? []) {
      if (branch.probability < minProbability) continue;
      const index = Math.min(branch.tubes.length - 1,
        Math.max(0, Math.round(t / Math.max(0.001, branch.tubes[1]?.t ?? 0.25))));
      const seg = branch.tubes[index];
      const delta = trackLength ? ((s - seg.s_mean + trackLength * 1.5) % trackLength) - trackLength * 0.5 : s - seg.s_mean;
      if (Math.abs(delta) <= seg.sweptBody.halfLength + seg.sigma_s + 2.32) {
        blocked.push([seg.q_min - 1.01, seg.q_max + 1.01]);
      }
    }
    blocked.sort((a, b) => a[0] - b[0]);
    const free = [];
    let cursor = qMinLegal;
    for (const [start, end] of blocked) {
      if (start > cursor + 0.1) free.push([cursor, Math.min(start, qMaxLegal)]);
      cursor = Math.max(cursor, end);
      if (cursor >= qMaxLegal) break;
    }
    if (cursor < qMaxLegal - 0.1) free.push([cursor, qMaxLegal]);
    return free.filter(([a, b]) => b - a > 0.2);
  }

  /**
   * Computes collision-free clearance corridors across legal track width
   */
  getClearanceCorridors(sAtEncounter, qMinLegal, qMaxLegal, t = null, trackLength = null) {
    if (t !== null) return this.freeIntervalsAt(sAtEncounter, t, qMinLegal, qMaxLegal, trackLength);
    if (!this.latestTubes || this.latestTubes.length === 0) {
      return [[qMinLegal, qMaxLegal]];
    }

    const obstacles = [];

    for (const opp of this.latestTubes) {
      for (const branch of opp.branches ?? [{ probability: 1, tubes: opp.tubes }]) {
        if (branch.probability < 0.08) continue;
        for (const seg of branch.tubes) {
        if (sAtEncounter >= seg.s_min && sAtEncounter <= seg.s_max) {
          obstacles.push([seg.q_min, seg.q_max]);
        }
        }
      }
    }

    if (obstacles.length === 0) {
      return [[qMinLegal, qMaxLegal]];
    }

    obstacles.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const obs of obstacles) {
      if (merged.length === 0) {
        merged.push([...obs]);
      } else {
        const last = merged[merged.length - 1];
        if (obs[0] <= last[1]) {
          last[1] = Math.max(last[1], obs[1]);
        } else {
          merged.push([...obs]);
        }
      }
    }

    const corridors = [];
    let curQ = qMinLegal;

    for (const obs of merged) {
      if (curQ < obs[0] - 0.2) {
        corridors.push([curQ, obs[0]]);
      }
      curQ = Math.max(curQ, obs[1]);
    }

    if (curQ < qMaxLegal - 0.2) {
      corridors.push([curQ, qMaxLegal]);
    }

    return corridors;
  }
}

export function createBeliefEngine(options) {
  return new NovaBeliefEngine(options);
}
