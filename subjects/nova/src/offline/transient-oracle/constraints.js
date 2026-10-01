// src/offline/transient-oracle/constraints.js
// Physical, Actuator, and Track Legal Boundary Constraints for Transient Optimal Control Oracle

import { clamp, angle } from '../../sim/math.js';

export class OracleConstraints {
  constructor(model, track = null, options = {}) {
    this.model = model;
    this.track = track;
    this.spec = model.spec;

    // Vehicle bounding box dimensions (GT class)
    this.halfWidth = options.halfWidth ?? (this.spec.halfWidth ?? 0.99);
    this.halfLength = options.halfLength ?? (this.spec.halfLength ?? 2.30);
    this.trackHalfWidth = options.trackHalfWidth ?? (track?.halfWidth ?? 6.5);

    // Actuator physical limits
    this.maxSteer = this.spec.steeringLock ?? 0.48; // rad
    this.maxSteerRate = options.maxSteerRate ?? 3.0; // rad/s
    this.minNormalLoad = options.minNormalLoad ?? 100.0; // N
  }

  /**
   * Evaluates vehicle 4-corner positions in world space.
   * @param {number} x World center x
   * @param {number} z World center z
   * @param {number} yaw Heading angle in rad
   * @returns {Array<{x: number, z: number}>} Front-left, front-right, rear-left, rear-right
   */
  getCorners(x, z, yaw) {
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const hl = this.halfLength;
    const hw = this.halfWidth;

    return [
      // Front-Left
      { x: x + hl * sinY - hw * cosY, z: z + hl * cosY + hw * sinY },
      // Front-Right
      { x: x + hl * sinY + hw * cosY, z: z + hl * cosY - hw * sinY },
      // Rear-Left
      { x: x - hl * sinY - hw * cosY, z: z - hl * cosY + hw * sinY },
      // Rear-Right
      { x: x - hl * sinY + hw * cosY, z: z - hl * cosY - hw * sinY }
    ];
  }

  /**
   * Evaluates track legality for vehicle bounding box.
   * Returns max penetration distance outside legal corridor (0 if fully legal).
   */
  trackViolation(x, z, yaw) {
    if (!this.track) return 0;
    const corners = this.getCorners(x, z, yaw);
    let maxViolation = 0;

    for (const c of corners) {
      if (this.track.nearest) {
        const p = this.track.nearest(c.x, c.z);
        const limit = this.track.halfWidth ?? this.trackHalfWidth;
        const v = Math.max(0, Math.abs(p.lateral) - limit);
        if (v > maxViolation) maxViolation = v;
      }
    }
    return maxViolation;
  }

  /**
   * Evaluates state and control constraints at a given node.
   * Returns dictionary of constraint values and violations.
   */
  evaluateNode(state, control, prevControl = null, dt = 0.05) {
    const deriv = this.model.derivatives(state, control);
    const violations = {};

    // 1. Steering angle bound (normalized to steeringLock)
    const steerViol = Math.max(0, Math.abs(state.delta) - this.maxSteer) / this.maxSteer;
    if (steerViol > 1e-4) violations.steer = steerViol;

    // 2. Steering rate bound (normalized to maxSteerRate)
    if (prevControl) {
      const steerRate = Math.abs((control.steer ?? (control.delta_cmd / this.maxSteer)) - (prevControl.steer ?? (prevControl.delta_cmd / this.maxSteer))) / Math.max(1e-4, dt);
      const steerRateViol = Math.max(0, steerRate - this.maxSteerRate) / this.maxSteerRate;
      if (steerRateViol > 1e-3) violations.steerRate = steerRateViol;
    }

    // 3. Normal load positivity (normalized to static vehicle weight mg)
    const mg = this.model.mass * 9.81;
    const frontLoadViol = Math.max(0, (this.minNormalLoad - deriv.F_z_front) / mg);
    const rearLoadViol = Math.max(0, (this.minNormalLoad - deriv.F_z_rear) / mg);
    if (frontLoadViol > 0) violations.frontNormalLoad = frontLoadViol;
    if (rearLoadViol > 0) violations.rearNormalLoad = rearLoadViol;

    // 4. Combined slip friction circle usage (must not exceed 1.0)
    const mu_f = deriv.mu_f ?? 1.48;
    const mu_r = deriv.mu_r ?? 1.48;
    const frontFricUsage = Math.hypot(deriv.F_x_f, deriv.F_y_f) / Math.max(100, mu_f * deriv.F_z_front);
    const rearFricUsage = Math.hypot(deriv.F_x_r, deriv.F_y_r) / Math.max(100, mu_r * deriv.F_z_rear);
    const frontFricViol = Math.max(0, frontFricUsage - 1.02);
    const rearFricViol = Math.max(0, rearFricUsage - 1.02);
    if (frontFricViol > 1e-3) violations.frontFriction = frontFricViol;
    if (rearFricViol > 1e-3) violations.rearFriction = rearFricViol;

    // 5. Track containment violation (in meters)
    const trackViol = this.trackViolation(state.x, state.z, state.yaw);
    if (trackViol > 1e-3) violations.track = trackViol;

    // Compute total L2 constraint residual
    let residualSq = 0;
    for (const k in violations) {
      residualSq += violations[k] * violations[k];
    }

    return {
      violations,
      maxViolation: Object.keys(violations).length > 0 ? Math.max(...Object.values(violations)) : 0,
      residual: Math.sqrt(residualSq),
      derivatives: deriv
    };
  }
}
