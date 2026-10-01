import * as THREE from 'three';

const MAX_CANDIDATES = 8;
const MAX_POINTS = 48;

const ALT_COLORS = {
  VIABLE: new THREE.Color(0x00d4ff),
  BLOCKED: new THREE.Color(0xff3355),
  EDGE_RISK: new THREE.Color(0xffa726),
  DEFAULT: new THREE.Color(0x546e7a),
  CHOSEN: new THREE.Color(0x00ff88),
};

const SPEED_COLORS = {
  HIGH: new THREE.Color(0x00ff88),
  FAST: new THREE.Color(0x00f0ff),
  MID: new THREE.Color(0xffea00),
  BRAKE: new THREE.Color(0xff3355),
};

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/**
 * 3D Multi-Candidate Frenet Trajectory Lattice Renderer
 * Visualizes the chosen local trajectory as a glowing 3D ribbon with vertex speed coloring,
 * renders the alternative candidate lattice colored by viability, and draws a pulsing waypoint beacon.
 */
export class CandidateSplineRenderer {
  constructor(parentGroup, options = {}) {
    this.group = new THREE.Group();
    this.group.name = 'DEEPSEEK_CANDIDATE_SPLINES';
    this.visible = true;
    this.showCandidates = true;
    this.showRibbon = true;

    this.ribbonWidth = options.ribbonWidth ?? 0.68;
    this.ribbonElevation = options.ribbonElevation ?? 0.22;

    // Temporary math vectors
    this._vCurr = new THREE.Vector3();
    this._vNext = new THREE.Vector3();
    this._vTangent = new THREE.Vector3();
    this._vNormal = new THREE.Vector3(0, 1, 0);
    this._vBinormal = new THREE.Vector3();
    this._speedColor = new THREE.Color();

    this._initChosenRibbon();
    this._initChosenCenterLine();
    this._initCandidateLattice();
    this._initWaypointBeacon();

    if (parentGroup) {
      parentGroup.add(this.group);
    }
  }

  _initChosenRibbon() {
    // Quad strip ribbon: (MAX_POINTS - 1) segments -> 2 triangles (6 vertices) per segment
    const maxVertices = (MAX_POINTS - 1) * 6;
    const positions = new Float32Array(maxVertices * 3);
    const colors = new Float32Array(maxVertices * 3);
    const normals = new Float32Array(maxVertices * 3);

    for (let i = 0; i < maxVertices; i++) {
      normals[i * 3 + 0] = 0;
      normals[i * 3 + 1] = 1;
      normals[i * 3 + 2] = 0;
    }

    this.ribbonGeometry = new THREE.BufferGeometry();
    this.ribbonGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.ribbonGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.ribbonGeometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    this.ribbonGeometry.setDrawRange(0, 0);

    this.ribbonMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
    });

    this.ribbonMesh = new THREE.Mesh(this.ribbonGeometry, this.ribbonMaterial);
    this.ribbonMesh.name = 'AI_CHOSEN_RIBBON';
    this.ribbonMesh.frustumCulled = false;
    this.group.add(this.ribbonMesh);
  }

  _initChosenCenterLine() {
    const positions = new Float32Array(MAX_POINTS * 3);
    const colors = new Float32Array(MAX_POINTS * 3);

    this.chosenLineGeometry = new THREE.BufferGeometry();
    this.chosenLineGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.chosenLineGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.chosenLineGeometry.setDrawRange(0, 0);

    this.chosenLineMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.98,
      depthWrite: false,
      depthTest: true,
    });

    this.chosenLine = new THREE.Line(this.chosenLineGeometry, this.chosenLineMaterial);
    this.chosenLine.name = 'AI_CHOSEN_CENTER_LINE';
    this.chosenLine.frustumCulled = false;
    this.group.add(this.chosenLine);
  }

  _initCandidateLattice() {
    this.candidates = [];
    for (let c = 0; c < MAX_CANDIDATES; c++) {
      const positions = new Float32Array(MAX_POINTS * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setDrawRange(0, 0);

      const material = new THREE.LineBasicMaterial({
        color: ALT_COLORS.DEFAULT,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        depthTest: true,
      });

      const line = new THREE.Line(geometry, material);
      line.name = `AI_CANDIDATE_LINE_${c}`;
      line.frustumCulled = false;
      line.visible = false;
      this.group.add(line);

      this.candidates.push({
        line,
        geometry,
        material,
        status: 'DEFAULT',
        offset: 0,
      });
    }
  }

  _initWaypointBeacon() {
    this.beaconGroup = new THREE.Group();
    this.beaconGroup.name = 'AI_LOOKAHEAD_BEACON';
    this.beaconGroup.visible = false;

    // Outer pulsating horizontal ring
    const ringGeom = new THREE.RingGeometry(0.5, 0.75, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00f0ff,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.beaconRing = new THREE.Mesh(ringGeom, ringMat);
    this.beaconRing.rotation.x = -Math.PI / 2;
    this.beaconGroup.add(this.beaconRing);

    // Inner bright center disc
    const innerGeom = new THREE.CircleGeometry(0.28, 16);
    const innerMat = new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.beaconInner = new THREE.Mesh(innerGeom, innerMat);
    this.beaconInner.rotation.x = -Math.PI / 2;
    this.beaconGroup.add(this.beaconInner);

    // Vertical holographic light needle
    const needleGeom = new THREE.CylinderGeometry(0.04, 0.04, 2.2, 8);
    const needleMat = new THREE.MeshBasicMaterial({
      color: 0x00f0ff,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    });
    this.beaconNeedle = new THREE.Mesh(needleGeom, needleMat);
    this.beaconNeedle.position.y = 1.1;
    this.beaconGroup.add(this.beaconNeedle);

    this.group.add(this.beaconGroup);
  }

  /**
   * Computes speed gradient color for a vertex:
   * Cyan/Green for top speed, Amber for coast/mid, Red for heavy braking.
   */
  _computeSpeedColor(speed, maxSpeed = 50, isBraking = false, outColor) {
    if (isBraking || speed < 12) {
      outColor.copy(SPEED_COLORS.BRAKE);
      return outColor;
    }
    const norm = clamp(speed / Math.max(24, maxSpeed), 0, 1);
    if (norm > 0.72) {
      outColor.copy(SPEED_COLORS.FAST).lerp(SPEED_COLORS.HIGH, (norm - 0.72) / 0.28);
    } else if (norm > 0.38) {
      outColor.copy(SPEED_COLORS.MID).lerp(SPEED_COLORS.FAST, (norm - 0.38) / 0.34);
    } else {
      outColor.copy(SPEED_COLORS.BRAKE).lerp(SPEED_COLORS.MID, norm / 0.38);
    }
    return outColor;
  }

  /**
   * Main update entry point
   * @param {Object} car - Vehicle object
   * @param {Object} driver - Driver adapter object with state and AI
   * @param {Object} line - Baked global RaceLine
   * @param {number} now - Timestamp in ms
   */
  update(car, driver, line, now = 0) {
    if (!this.visible || !car) {
      this.hide();
      return;
    }

    const ai = driver?.ai;
    const traj = ai?.trajectoryPlan;
    const plan = ai?.local;
    const model = line?.model;

    // 1. Update Chosen Intended Trajectory Ribbon & Filament
    const hasTraj = traj?.points && traj.points.length >= 2;
    const hasPlan = plan?.path && plan.path.n >= 2;

    if (this.showRibbon && (hasTraj || hasPlan)) {
      this._updateChosenRibbon(car, traj, plan, driver);
      this._updateChosenCenterLine(traj, plan, driver);
      this._updateBeacon(traj, plan, now);
    } else {
      this.ribbonGeometry.setDrawRange(0, 0);
      this.chosenLineGeometry.setDrawRange(0, 0);
      this.beaconGroup.visible = false;
    }

    // 2. Generate and Update Frenet Candidate Lattice ("All Possible Paths")
    if (this.showCandidates && model && car) {
      this._updateCandidateLattice(car, traj, plan, model, driver);
    } else {
      for (const cand of this.candidates) {
        cand.line.visible = false;
        cand.geometry.setDrawRange(0, 0);
      }
    }
  }

  _updateChosenRibbon(car, traj, plan, driver) {
    const points = traj?.points;
    const isTraj = Array.isArray(points) && points.length >= 2;
    const count = isTraj ? Math.min(MAX_POINTS, points.length) : Math.min(MAX_POINTS, plan.path.n);
    if (count < 2) {
      this.ribbonGeometry.setDrawRange(0, 0);
      return;
    }

    const posAttr = this.ribbonGeometry.attributes.position;
    const colAttr = this.ribbonGeometry.attributes.color;
    const posArr = posAttr.array;
    const colArr = colAttr.array;
    const halfWidth = this.ribbonWidth * 0.5;
    const isBraking = Boolean(driver?.state?.plannedBrake || (driver?.state?.brake > 0.05));
    const maxSpeed = Math.max(42, car.speed * 1.25);

    let vertIndex = 0;

    for (let k = 0; k < count - 1; k++) {
      let x0, z0, v0;
      let x1, z1, v1;

      if (isTraj) {
        const p0 = points[k];
        const p1 = points[k + 1];
        x0 = p0.x; z0 = p0.z; v0 = p0.speed;
        x1 = p1.x; z1 = p1.z; v1 = p1.speed;
      } else {
        x0 = plan.path.px[k]; z0 = plan.path.pz[k]; v0 = plan.profile?.v ? plan.profile.v[k] : car.speed;
        x1 = plan.path.px[k + 1]; z1 = plan.path.pz[k + 1]; v1 = plan.profile?.v ? plan.profile.v[k + 1] : car.speed;
      }

      this._vCurr.set(x0, this.ribbonElevation, z0);
      this._vNext.set(x1, this.ribbonElevation, z1);
      this._vTangent.subVectors(this._vNext, this._vCurr).normalize();
      if (this._vTangent.lengthSq() < 1e-4) {
        this._vTangent.set(0, 0, 1);
      }
      this._vBinormal.crossVectors(this._vTangent, this._vNormal).normalize();

      // Ribbon quad vertices
      const p0_Lx = this._vCurr.x - this._vBinormal.x * halfWidth;
      const p0_Lz = this._vCurr.z - this._vBinormal.z * halfWidth;
      const p0_Rx = this._vCurr.x + this._vBinormal.x * halfWidth;
      const p0_Rz = this._vCurr.z + this._vBinormal.z * halfWidth;

      const p1_Lx = this._vNext.x - this._vBinormal.x * halfWidth;
      const p1_Lz = this._vNext.z - this._vBinormal.z * halfWidth;
      const p1_Rx = this._vNext.x + this._vBinormal.x * halfWidth;
      const p1_Rz = this._vNext.z + this._vBinormal.z * halfWidth;

      // Color mapping
      this._computeSpeedColor(v0, maxSpeed, isBraking, this._speedColor);
      const c0_r = this._speedColor.r, c0_g = this._speedColor.g, c0_b = this._speedColor.b;

      this._computeSpeedColor(v1, maxSpeed, isBraking, this._speedColor);
      const c1_r = this._speedColor.r, c1_g = this._speedColor.g, c1_b = this._speedColor.b;

      // Triangle 1: p0_L, p0_R, p1_L
      posArr[vertIndex * 3 + 0] = p0_Lx; posArr[vertIndex * 3 + 1] = this.ribbonElevation; posArr[vertIndex * 3 + 2] = p0_Lz;
      colArr[vertIndex * 3 + 0] = c0_r;  colArr[vertIndex * 3 + 1] = c0_g;                 colArr[vertIndex * 3 + 2] = c0_b;
      vertIndex++;

      posArr[vertIndex * 3 + 0] = p0_Rx; posArr[vertIndex * 3 + 1] = this.ribbonElevation; posArr[vertIndex * 3 + 2] = p0_Rz;
      colArr[vertIndex * 3 + 0] = c0_r;  colArr[vertIndex * 3 + 1] = c0_g;                 colArr[vertIndex * 3 + 2] = c0_b;
      vertIndex++;

      posArr[vertIndex * 3 + 0] = p1_Lx; posArr[vertIndex * 3 + 1] = this.ribbonElevation; posArr[vertIndex * 3 + 2] = p1_Lz;
      colArr[vertIndex * 3 + 0] = c1_r;  colArr[vertIndex * 3 + 1] = c1_g;                 colArr[vertIndex * 3 + 2] = c1_b;
      vertIndex++;

      // Triangle 2: p0_R, p1_R, p1_L
      posArr[vertIndex * 3 + 0] = p0_Rx; posArr[vertIndex * 3 + 1] = this.ribbonElevation; posArr[vertIndex * 3 + 2] = p0_Rz;
      colArr[vertIndex * 3 + 0] = c0_r;  colArr[vertIndex * 3 + 1] = c0_g;                 colArr[vertIndex * 3 + 2] = c0_b;
      vertIndex++;

      posArr[vertIndex * 3 + 0] = p1_Rx; posArr[vertIndex * 3 + 1] = this.ribbonElevation; posArr[vertIndex * 3 + 2] = p1_Rz;
      colArr[vertIndex * 3 + 0] = c1_r;  colArr[vertIndex * 3 + 1] = c1_g;                 colArr[vertIndex * 3 + 2] = c1_b;
      vertIndex++;

      posArr[vertIndex * 3 + 0] = p1_Lx; posArr[vertIndex * 3 + 1] = this.ribbonElevation; posArr[vertIndex * 3 + 2] = p1_Lz;
      colArr[vertIndex * 3 + 0] = c1_r;  colArr[vertIndex * 3 + 1] = c1_g;                 colArr[vertIndex * 3 + 2] = c1_b;
      vertIndex++;
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.ribbonGeometry.setDrawRange(0, vertIndex);
    this.ribbonMesh.visible = true;
  }

  _updateChosenCenterLine(traj, plan, driver) {
    const points = traj?.points;
    const isTraj = Array.isArray(points) && points.length >= 2;
    const count = isTraj ? Math.min(MAX_POINTS, points.length) : Math.min(MAX_POINTS, plan.path.n);

    const posAttr = this.chosenLineGeometry.attributes.position;
    const colAttr = this.chosenLineGeometry.attributes.color;
    const posArr = posAttr.array;
    const colArr = colAttr.array;
    const elevation = this.ribbonElevation + 0.05;

    for (let k = 0; k < count; k++) {
      const px = isTraj ? points[k].x : plan.path.px[k];
      const pz = isTraj ? points[k].z : plan.path.pz[k];
      posArr[k * 3 + 0] = px;
      posArr[k * 3 + 1] = elevation;
      posArr[k * 3 + 2] = pz;

      colArr[k * 3 + 0] = 0.85;
      colArr[k * 3 + 1] = 1.0;
      colArr[k * 3 + 2] = 0.95;
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.chosenLineGeometry.setDrawRange(0, count);
    this.chosenLine.visible = true;
  }

  /**
   * Generates a fan of alternate Frenet trajectories spanning the track width
   * and evaluates viability (legal margin, track edge risk).
   */
  _updateCandidateLattice(car, traj, plan, model, driver) {
    const qLegal = model.qLegal ?? 6.4;
    // 7 corridors smoothly distributed across the track width
    const corridorFractions = [-0.78, -0.52, -0.26, 0.0, 0.26, 0.52, 0.78];
    const L = Math.max(40, Math.min(95, car.speed * 2.0));
    const samples = 24;
    const s0 = car.s;
    const q0 = car.lateral;
    const targetQ = driver?.state?.targetQ ?? q0;

    corridorFractions.forEach((frac, idx) => {
      if (idx >= MAX_CANDIDATES) return;
      const cand = this.candidates[idx];
      const posArr = cand.geometry.attributes.position.array;
      const targetCorridorQ = frac * qLegal;

      let edgeRisk = Math.abs(targetCorridorQ) > qLegal * 0.76;
      let blocked = Math.abs(targetCorridorQ) > qLegal * 0.95;

      for (let k = 0; k < samples; k++) {
        const u = k / (samples - 1);
        const dist = u * L;
        // Smooth Hermite blend from current car lateral to corridor
        const blend = u * u * (3 - 2 * u);
        const qVal = q0 + (targetCorridorQ - q0) * blend;
        const pt = model.point(s0 + dist, qVal);

        posArr[k * 3 + 0] = pt.x;
        posArr[k * 3 + 1] = this.ribbonElevation - 0.04;
        posArr[k * 3 + 2] = pt.z;
      }

      // Check if this corridor is close to the chosen target line
      const isChosen = Math.abs(targetCorridorQ - targetQ) < (qLegal * 0.18);
      let color = ALT_COLORS.VIABLE;
      let opacity = 0.42;

      if (blocked) {
        color = ALT_COLORS.BLOCKED;
        opacity = 0.55;
      } else if (edgeRisk) {
        color = ALT_COLORS.EDGE_RISK;
        opacity = 0.50;
      } else if (isChosen) {
        color = ALT_COLORS.CHOSEN;
        opacity = 0.70;
      }

      cand.material.color.copy(color);
      cand.material.opacity = opacity;
      cand.geometry.attributes.position.needsUpdate = true;
      cand.geometry.setDrawRange(0, samples);
      cand.line.visible = true;
      cand.status = blocked ? 'BLOCKED' : edgeRisk ? 'EDGE_RISK' : isChosen ? 'CHOSEN' : 'VIABLE';
      cand.offset = targetCorridorQ;
    });
  }

  _updateBeacon(traj, plan, now) {
    const points = traj?.points;
    let bx = 0, bz = 0;

    if (traj?.trackingPoint) {
      bx = traj.trackingPoint.x;
      bz = traj.trackingPoint.z;
    } else if (Array.isArray(points) && points.length >= 4) {
      const targetIdx = Math.min(points.length - 1, 6);
      bx = points[targetIdx].x;
      bz = points[targetIdx].z;
    } else if (plan?.path?.n >= 2) {
      const targetIdx = Math.min(plan.path.n - 1, 6);
      bx = plan.path.px[targetIdx];
      bz = plan.path.pz[targetIdx];
    } else {
      this.beaconGroup.visible = false;
      return;
    }

    this.beaconGroup.position.set(bx, this.ribbonElevation + 0.05, bz);
    this.beaconGroup.visible = true;

    // Pulsing animation
    const pulse = 1.0 + Math.sin(now * 0.006) * 0.20;
    this.beaconRing.scale.set(pulse, pulse, 1);
    this.beaconRing.material.opacity = 0.65 + Math.sin(now * 0.008) * 0.25;
  }

  hide() {
    this.ribbonGeometry.setDrawRange(0, 0);
    this.chosenLineGeometry.setDrawRange(0, 0);
    this.beaconGroup.visible = false;
    for (const c of this.candidates) {
      c.line.visible = false;
      c.geometry.setDrawRange(0, 0);
    }
  }

  setVisible(val) {
    this.visible = val;
    this.group.visible = val;
  }
}
