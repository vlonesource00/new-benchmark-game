import { clamp, wrap } from '../../../sim/math.js';
import { ATTACK_CORRIDOR_MARGIN } from '../interaction/clearance.js';
import { GripRobustness } from './grip-robustness.js';

const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

/**
 * Latched reference reacquisition.
 *
 * The racing line is fixed. When the car is far enough off it that joining Q0
 * over the available distance is physically infeasible, a single bridge
 * trajectory is latched from the car's ACTUAL state at that moment and driven
 * to a merge station on Q0. The bridge lives in track-station coordinates and
 * never moves with the car afterwards; as the car advances it samples further
 * along the same fixed curve. When it is completed the state clears and Q0
 * returns to exactly the legacy path.
 *
 * The trigger is the existing reachability law written as a dimensionless
 * burden - required lateral demand over available lateral authority - not a
 * raw tracking-error threshold.
 */
export class LatchedAcquisition {
  /**
   * Six boundary conditions: q, q', q'' at the start and at the merge. A
   * quintic has exactly six coefficients, so it is precisely sufficient here -
   * no spare degrees of freedom, none missing. Coefficients are in u = (s-s0)/L
   * with the derivative terms expressed in u; quinticCoefficients applies the
   * length scaling internally, so callers pass RAW per-station q' and q''.
   */
  constructor(ego, s0, sMerge, startQ, startDqds, startD2qds2, qMerge, dqdsMerge, d2qds2Merge, burden) {
    this.s0 = s0;
    this.q0 = startQ;
    this.dqds0 = startDqds;
    this.d2qds20 = startD2qds2;
    this.heading0 = ego.yaw;
    this.yawRate0 = ego.yawRate;
    this.beta0 = Math.atan2(ego.v ?? 0, Math.max(4, ego.u ?? 0));
    this.speed0 = ego.speed;
    this.sMerge = sMerge;
    this.qMerge = qMerge;
    this.dqdsMerge = dqdsMerge;
    this.d2qds2Merge = d2qds2Merge;
    this.burden = burden;
    const L = Math.max(1, sMerge - s0);
    this.length = L;
    this.coefficients = quinticCoefficients(
      { q: startQ, dqds: startDqds, d2qds2: startD2qds2 },
      { q: qMerge, dqds: dqdsMerge, d2qds2: d2qds2Merge },
      L,
    );
  }
  /** Lateral offset of the latched bridge at a station. */
  qAt(s, wrapFn, trackLength) {
    const d = wrapFn(s - this.s0, trackLength);
    if (d >= this.length) return null;
    const u = d / this.length;
    const [c0, c1, c2, c3, c4, c5] = this.coefficients;
    return ((((c5 * u + c4) * u + c3) * u + c2) * u + c1) * u + c0;
  }
  /** dq/ds of the bridge at a station. */
  dqdsAt(s, wrapFn, trackLength) {
    const d = wrapFn(s - this.s0, trackLength);
    if (d >= this.length) return null;
    const u = d / this.length;
    const [c0, c1, c2, c3, c4, c5] = this.coefficients;
    return (c1 + 2 * c2 * u + 3 * c3 * u * u + 4 * c4 * u ** 3 + 5 * c5 * u ** 4) / this.length;
  }
  done(s, wrapFn, trackLength) {
    return wrapFn(s - this.s0, trackLength) >= this.length;
  }
}

function quinticCoefficients(start, end, length) {
  const D = end.q - start.q - start.dqds * length - 0.5 * start.d2qds2 * length * length;
  const E = end.dqds * length - start.dqds * length - start.d2qds2 * length * length;
  const F = (end.d2qds2 - start.d2qds2) * length * length;
  return [start.q, start.dqds * length, 0.5 * start.d2qds2 * length * length,
    10 * D - 4 * E + 0.5 * F, -15 * D + 7 * E - F, 6 * D - 3 * E + 0.5 * F];
}

export class CorridorGenerator {
  constructor(atlas, maxDistance = 220, step = 10) {
    this.atlas = atlas;
    this.track = atlas.track;
    this.maxDistance = maxDistance;
    this.step = step;
    // Free-air line geometry, selected on live grip. Combat corridors are
    // built from the nominal line and are unaffected by this.
    this.robustness = new GripRobustness(atlas, atlas.track);
  }

  generate(ego, opponents, contract = null, corridorOwnership = null) {
    const atlas = this.atlas;
    const trackHalfW = this.track.halfWidth;
    const legalW = trackHalfW - (ego.spec?.halfWidth ?? 0.99) - 0.20;

    const ownedCorridor = corridorOwnership?.getOwnedCorridor?.() ?? { active: false };

    const profiles = [{ id: 'Q0', targetShift: 0, focus: null, flank: 0 }];
    if (opponents.length) {
      profiles.push(...[-3.2, -1.8, -.8, .8, 1.8, 3.2]
        .map((targetShift, i) => ({
          id: `Q${i + 1}`,
          targetShift,
          focus: null,
          flank: Math.sign(targetShift)
        })));
    }

    // Add dedicated owned-corridor candidate when side-by-side or approaching in traffic
    if (ownedCorridor.active) {
      const qMin = ownedCorridor.qMin;
      const qMax = ownedCorridor.qMax;
      const flank = ownedCorridor.flank;
      const safeBuffer = Math.min(0.55, Math.max(0.1, (qMax - qMin) * 0.25));
      const optQ = clamp(atlas.lineOffset(ego.s), qMin + safeBuffer, qMax - safeBuffer);
      profiles.unshift({
        id: `OWNED_OPT`,
        targetLateral: optQ,
        targetShift: optQ - atlas.lineOffset(ego.s),
        focus: ownedCorridor.primaryRival,
        focusStation: 20,
        flank,
        committed: true,
        isOwnedCorridor: true
      });
    }

    for (const rival of opponents) {
      const ds = wrap(rival.s - ego.s + this.track.length / 2, this.track.length) - this.track.length / 2;
      if (ds < -3.0 || ds > 62) continue;

      for (const flank of [-1, 1]) {
        // Multi-car squeeze check (Section 20):
        // If an abreast rival sits in this flank direction, check if the gap between them is physically passable.
        let blocked = false;
        for (const other of opponents) {
          if (other.id === rival.id) continue;
          const otherDs = Math.abs(wrap(other.s - rival.s + this.track.length / 2, this.track.length) - this.track.length / 2);
          if (otherDs < 14.0) {
            const egoW = ego.spec?.halfWidth ?? 0.99;
            const rW = rival.spec?.halfWidth ?? 0.99;
            const oW = other.spec?.halfWidth ?? 0.99;
            if (flank < 0 && other.lateral < rival.lateral) {
              const freeGap = (rival.lateral - rW) - (other.lateral + oW);
              if (freeGap < 2 * egoW + 0.7) {
                blocked = true;
                break;
              }
            } else if (flank > 0 && other.lateral > rival.lateral) {
              const freeGap = (other.lateral - oW) - (rival.lateral + rW);
              if (freeGap < 2 * egoW + 0.7) {
                blocked = true;
                break;
              }
            }
          }
        }
        if (blocked) continue;

        const station = wrap(rival.s + Math.max(-2, Math.min(9, (rival.longitudinalSpeed ?? rival.speed ?? 0) * .16)), this.track.length);
        const base = atlas.lineOffset(station);
        const lateral = clamp(
          rival.lateral + flank * (ego.spec.halfWidth + rival.spec.halfWidth + ATTACK_CORRIDOR_MARGIN),
          -legalW,
          legalW
        );
        const targetShift = clamp(lateral - base, -3.8, 3.8);
        profiles.push({
          id: `E${rival.id}${flank < 0 ? 'L' : 'R'}`,
          targetShift,
          focus: rival.id,
          focusStation: Math.max(12, ds),
          targetLateral: lateral,
          flank
        });
      }
    }

    if (contract) {
      const rival = opponents.find(item => item.id === contract.opponentId);
      if (rival) {
        const dsRival = wrap(rival.s - ego.s + this.track.length / 2, this.track.length) - this.track.length / 2;
        if (dsRival >= -4.5) {
          const base = atlas.lineOffset(wrap(ego.s + 20, this.track.length));
          const lockLateral = clamp(
            contract.targetLateral ?? (rival.lateral + contract.flank * (ego.spec.halfWidth + rival.spec.halfWidth + ATTACK_CORRIDOR_MARGIN)),
            -legalW,
            legalW
          );
          const lockShift = clamp(lockLateral - base, -3.8, 3.8);
          profiles.unshift({
            id: `LOCK${rival.id}`,
            targetShift: lockShift,
            focus: rival.id,
            focusStation: 22,
            targetLateral: lockLateral,
            flank: contract.flank,
            committed: true
          });
        }
      }
    }

    // ---- latched reference reacquisition -------------------------------
    // Trigger is a dimensionless ACQUISITION BURDEN: the lateral acceleration
    // a C2 quintic must produce to cover displacement dq over the planner's own
    // reachability horizon, divided by the lateral authority actually
    // available. The peak d2q/ds2 of a quintic is 1.875*dq/L^2, so
    // a_q = 1.875 * v^2 * dq / L^2. It fires when joining Q0 is physically
    // infeasible, not when a raw tracking error crosses an arbitrary number.
    const ACQ_PEAK = 1.875;
    const ACQ_HORIZON = 60;
    if (this.acquisition?.done(ego.s, wrap, this.track.length)) this.acquisition = null;
    if (!this.acquisition) {
      const atOrigin = atlas.lineOffset(ego.s) + (this.robustness?.shift?.(ego.s) ?? 0);
      const dq = Math.abs(atOrigin - ego.lateral);
      const envA = this.atlas?.envelope?.at?.(ego, Math.max(1, ego.speed), 0, ego.lateral);
      const aAvail = Math.max(1, (envA?.lateral ?? 20) * (envA?.reserve ?? 1));
      const speed = Math.max(1, ego.speed);
      // The budget is TIME, not distance: over a 60 m horizon at racing speed
      // the car has seconds in hand and almost any displacement looks
      // feasible, which is why the same test never fired at the measured L6
      // state. ACQ_TIME is the window in which the car must be able to come
      // back onto the racing line.
      const ACQ_TIME = 1.0;
      // PROJECTED displacement, not raw. Measured L6/L7: divergence begins at
      // s~986 with qErr 2 m while the raw-displacement burden stays under 1
      // for another 200 m, so the car departs before the trigger registers.
      // The outward lateral station rate is the physically meaningful term -
      // v * sin(heading - track heading) - projected forward over the budget.
      const trackHeading = this.track.at(ego.s)?.heading ?? 0;
      // MEASURED AND REJECTED: projecting the displacement forward with the
      // outward lateral rate does make the trigger fire, but the bridge it
      // latches is worse than doing nothing - lap 6 went 95.1 -> 117.0 s and
      // lap 7 109.4 -> 130.4 s, with 5 re-latch episodes and 44 s latched on
      // lap 6 and max |qErr| rising 17.8 -> 26.2 m. The failure is not trigger
      // latency; when the bridge engages it does not win. Kept as the raw
      // displacement form, under which the latch is dormant on every measured
      // lap and the car runs the proven refiner-corrected behaviour.
      void trackHeading;
      const lateralDemand = ACQ_PEAK * dq / (ACQ_TIME * ACQ_TIME);
      const burden = lateralDemand / aAvail;
      this.lastAcquisitionBurden = burden;
      if (burden > 1 && dq > 0.25 && !this.acquisition) {
        const s0 = ego.s;
        // ---- REAL INITIAL FRENET STATE (section 3) ----
        // q is the offset along the track normal, so the true lateral slope is
        // v_normal / v_tangent. Sign convention checked against measured q
        // evolution: the normal used by track.at is the same one that defines
        // q, so this is dq/ds without a sign flip.
        const frame = this.track.at(s0);
        const vT = (ego.vx ?? 0) * frame.tx + (ego.vz ?? 0) * frame.tz;
        const vN = (ego.vx ?? 0) * frame.nx + (ego.vz ?? 0) * frame.nz;
        const qPrime0 = vN / Math.max(3, Math.abs(vT));
        // q''0 from the driven curvature is NOT added: it over-constrains the
        // start relative to what the plant can verify, and measurement did not
        // show it improves continuity. Match q and q' at the start.
        const startD2 = 0;

        const qAt = (x) => atlas.lineOffset(wrap(x, this.track.length)) + (this.robustness?.shift?.(x) ?? 0);
        const mergeState = (sMerge) => {
          const h = 2.0;
          const qm = qAt(sMerge - h), q0m = qAt(sMerge), qp = qAt(sMerge + h);
          return { q: q0m, dqds: (qp - qm) / (2 * h), d2qds2: (qp - 2 * q0m + qm) / (h * h) };
        };

        // ---- DEMAND-SOLVED LENGTH (sections 8-10) ----
        // 60 m is an initial guess only. Build the bridge, sample it densely in
        // world coordinates, derive its curvature and the lateral acceleration
        // it demands, and lengthen until that demand fits inside the live
        // capability. Deterministic: grow to bracket, then bisect.
        const build = (L) => {
          const m = mergeState(wrap(s0 + L, this.track.length));
          return new LatchedAcquisition(ego, s0, wrap(s0 + L, this.track.length),
            ego.lateral, qPrime0, startD2, m.q, m.dqds, m.d2qds2, burden);
        };
        const wheelbase = ego.spec?.wheelbase ?? 2.9;
        const steerLock = ego.spec?.steeringLock ?? 0.55;
        const demand = (bridge) => {
          let peak = 0;
          const N = 24;
          for (let i = 0; i <= N; i++) {
            const s = s0 + (bridge.length * i) / N;
            const q = bridge.qAt(s, wrap, this.track.length);
            const p = this.track.at(wrap(s, this.track.length), q);
            const h = 2.0;
            const a = this.track.at(wrap(s - h, this.track.length), bridge.qAt(s - h, wrap, this.track.length));
            const c = this.track.at(wrap(s + h, this.track.length), bridge.qAt(s + h, wrap, this.track.length));
            const l1 = Math.hypot(p.x - a.x, p.z - a.z), l2 = Math.hypot(c.x - p.x, c.z - p.z);
            const cross = (p.x - a.x) * (c.z - p.z) - (p.z - a.z) * (c.x - p.x);
            const kappa = Math.abs(2 * cross / Math.max(1e-6, l1 * l2 * (l1 + l2)));
            peak = Math.max(peak, kappa);
          }
          return peak;
        };
        const feasible = (bridge) => {
          const k = demand(bridge);
          const ayReq = speed * speed * k;
          const steerReq = Math.abs(Math.atan(wheelbase * k));
          return ayReq <= aAvail && steerReq <= steerLock;
        };

        let L = Math.max(60, speed * Math.sqrt(ACQ_PEAK * dq / aAvail));
        let bridge = build(L);
        if (!feasible(bridge)) {
          let hi = L, lo = L;
          for (let grow = 0; grow < 6 && !feasible(build(hi)); grow++) { lo = hi; hi *= 1.5; }
          if (!feasible(build(hi))) { this.acquisition = null; this.lastAcquisitionBurden = burden; }
          else {
            for (let it = 0; it < 8; it++) {
              const mid = (lo + hi) / 2;
              if (feasible(build(mid))) hi = mid; else lo = mid;
            }
            bridge = build(hi);
          }
        }
        if (bridge && feasible(bridge)) this.acquisition = bridge;
      }
    }

    const candidates = [];
    for (const profile of profiles) {
      const points = [];
      const ramp = profile.focusStation ? Math.max(14, Math.min(22, profile.focusStation)) : 18;

      for (let distance = 0; distance <= this.maxDistance; distance += this.step) {
        const s = wrap(ego.s + distance, this.track.length);
        const baseLineQ = atlas.lineOffset(s);

        const isQ0 = profile.id === 'Q0' && !profile.isOwnedCorridor;

        if (isQ0) {
          // EXACT LEGACY Q0 whenever no acquisition is latched. Healthy
          // operation must pay zero architectural tax - same points, offsets,
          // world geometry, curvature and speed as production.
          if (!this.acquisition) {
            const p = atlas.sample(s, this.robustness.shift(s));
            points.push({
              ...p,
              distance,
              shift: 0,
              offset: p.offset,
              speed: p.speed,
              speedLimit: p.speed,
              lateralLimit: this.track.halfWidth - ego.spec.halfWidth - .16,
              demand: 0
            });
            continue;
          }
          // REACQUIRING: sample the ONE latched bridge. The curve is fixed in
          // track-station coordinates from s0 and never moves with the car.
          const qBridge = this.acquisition.qAt(s, wrap, this.track.length);
          const targetQ = atlas.sample(s, this.robustness.shift(s)).offset;
          const q = qBridge === null ? targetQ : qBridge;
          const shift = q - baseLineQ;
          const p = atlas.sample(s, shift);
          points.push({
            ...p,
            distance,
            shift,
            offset: q,
            speed: p.speed,
            speedLimit: p.speed,
            lateralLimit: this.track.halfWidth - ego.spec.halfWidth - .16,
            demand: 0
          });
          continue;
        }

        let targetQ;
        if (profile.isOwnedCorridor && ownedCorridor.active) {
          const safeBuffer = Math.min(0.55, Math.max(0.1, (ownedCorridor.qMax - ownedCorridor.qMin) * 0.25));
          targetQ = clamp(baseLineQ, ownedCorridor.qMin + safeBuffer, ownedCorridor.qMax - safeBuffer);
        } else if (Number.isFinite(profile.targetLateral)) {
          targetQ = profile.targetLateral;
        } else {
          targetQ = baseLineQ + profile.targetShift;
        }
        targetQ = clamp(targetQ, -legalW, legalW);

        // Continuous origin transition: at distance 0, start smoothly at ego.lateral
        const transition = smooth(distance / ramp);
        let q = ego.lateral + (targetQ - ego.lateral) * transition;

        if (!profile.isOwnedCorridor && profile.focusStation && distance > profile.focusStation + 20) {
          const exitBlend = smooth((distance - profile.focusStation - 20) / 36);
          // Gently blend toward the optimal track line post-pass if clear, bounded by owned corridor
          const targetExitQ = ownedCorridor.active
            ? clamp(baseLineQ, ownedCorridor.qMin + 0.25, ownedCorridor.qMax - 0.25)
            : clamp(baseLineQ, -legalW, legalW);
          q = q * (1 - exitBlend) + targetExitQ * exitBlend;
        }

        q = clamp(q, -legalW, legalW);
        const shift = q - baseLineQ;
        const p = atlas.sample(s, shift);

        points.push({
          ...p,
          distance,
          shift,
          offset: q,
          speed: p.speed,
          speedLimit: p.speed,
          lateralLimit: this.track.halfWidth - ego.spec.halfWidth - .16,
          demand: 0
        });
      }

      candidates.push({
        id: profile.id,
        points,
        targetId: profile.focus,
        targetLateral: profile.targetLateral ?? points.at(-1)?.offset,
        flank: profile.flank ?? 0,
        committed: Boolean(profile.committed),
        targetShift: profile.targetShift,
        isOwnedCorridor: Boolean(profile.isOwnedCorridor)
      });
    }

    return candidates;
  }
}
