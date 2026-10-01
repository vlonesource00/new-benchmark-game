import * as THREE from 'three';

const MAX_OPPONENTS = 8;
const TIME_HORIZONS = [0.5, 1.0, 2.0, 3.0];
const HORIZON_COLORS = [
  new THREE.Color(0xff3344), // 0.5s: Urgent Red
  new THREE.Color(0xff9100), // 1.0s: Amber
  new THREE.Color(0xffd600), // 2.0s: Gold
  new THREE.Color(0x00e5ff), // 3.0s: Cyan
];

const CORRIDOR_SEGMENTS = 32;
const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const CORRIDOR_COLORS = {
  ATTACK_INSIDE: { base: new THREE.Color(0x00ff88), top: new THREE.Color(0x76ff03) },
  INSIDE: { base: new THREE.Color(0x00ff88), top: new THREE.Color(0x76ff03) },
  ATTACK_OUTSIDE: { base: new THREE.Color(0x00e5ff), top: new THREE.Color(0x18ffff) },
  OUTSIDE: { base: new THREE.Color(0x00e5ff), top: new THREE.Color(0x18ffff) },
  DIVEBOMB: { base: new THREE.Color(0xff1744), top: new THREE.Color(0xff5252) },
  SWITCHBACK: { base: new THREE.Color(0xffea00), top: new THREE.Color(0xffff00) },
  DEFEND_INSIDE: { base: new THREE.Color(0xaa00ff), top: new THREE.Color(0xe040fb) },
  DEFEND: { base: new THREE.Color(0xf05cff), top: new THREE.Color(0xe040fb) },
  DEFAULT: { base: new THREE.Color(0x00e5ff), top: new THREE.Color(0x18ffff) },
};

/**
 * 3D Tactical Zone & Opponent Prediction Renderer
 * Renders opponent space-time forecast bounding boxes & trajectory rays across horizons (0.5s - 3.0s),
 * illuminated 3D tactical corridor road strips, and dynamic laser braking crossbars.
 */
export class TacticalZoneRenderer {
  constructor(parentGroup, options = {}) {
    this.group = new THREE.Group();
    this.group.name = 'DEEPSEEK_TACTICAL_ZONE';
    this.visible = true;
    this.showPredictions = true;
    this.showCorridors = true;
    this.showBraking = true;

    this.carDimensions = {
      length: options.carLength ?? 4.65,
      width: options.carWidth ?? 2.02,
      height: options.carHeight ?? 1.20,
    };

    // Reusable math structures
    this._vRef = new THREE.Vector3();
    this._vHeading = new THREE.Vector3();
    this._vRight = new THREE.Vector3();
    this._vUp = new THREE.Vector3(0, 1, 0);
    this._vCorner = new THREE.Vector3();

    this._initPredictionBoxes();
    this._initTacticalCorridorRibbon();
    this._initBrakingMarker();

    if (parentGroup) {
      parentGroup.add(this.group);
    }
  }

  _initPredictionBoxes() {
    // Each box: 12 lines (24 vertices).
    // Center rays connecting 4 horizons: 4 segments (8 vertices).
    // Total per opponent = 4 boxes * 24 + 8 = 104 vertices.
    const totalVertices = MAX_OPPONENTS * (TIME_HORIZONS.length * 24 + 8);
    const positions = new Float32Array(totalVertices * 3);
    const colors = new Float32Array(totalVertices * 3);

    this.predictionGeometry = new THREE.BufferGeometry();
    this.predictionGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.predictionGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.predictionGeometry.setDrawRange(0, 0);

    this.predictionMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      depthTest: true,
    });

    this.predictionLines = new THREE.LineSegments(this.predictionGeometry, this.predictionMaterial);
    this.predictionLines.name = 'AI_OPPONENT_PREDICTION_BOXES';
    this.predictionLines.frustumCulled = false;
    this.group.add(this.predictionLines);
  }

  _initTacticalCorridorRibbon() {
    // 3D Quad Strip ribbon on road surface: CORRIDOR_SEGMENTS * 2 triangles (6 vertices)
    const totalVertices = CORRIDOR_SEGMENTS * 6;
    const positions = new Float32Array(totalVertices * 3);
    const colors = new Float32Array(totalVertices * 3);

    this.corridorGeometry = new THREE.BufferGeometry();
    this.corridorGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.corridorGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.corridorGeometry.setDrawRange(0, 0);

    this.corridorMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
    });

    this.corridorMesh = new THREE.Mesh(this.corridorGeometry, this.corridorMaterial);
    this.corridorMesh.name = 'AI_TACTICAL_CORRIDOR_SURFACE';
    this.corridorMesh.frustumCulled = false;
    this.corridorMesh.visible = false;
    this.group.add(this.corridorMesh);
  }

  _initBrakingMarker() {
    this.brakingGroup = new THREE.Group();
    this.brakingGroup.name = 'AI_DYNAMIC_BRAKING_MARKER';
    this.brakingGroup.visible = false;

    // Glowing transverse laser bar spanning track
    const barGeom = new THREE.BoxGeometry(10.5, 0.08, 0.45);
    const barMat = new THREE.MeshBasicMaterial({
      color: 0xff3355,
      transparent: true,
      opacity: 0.90,
      depthWrite: false,
    });
    this.brakingBar = new THREE.Mesh(barGeom, barMat);
    this.brakingBar.position.y = 0.28;
    this.brakingGroup.add(this.brakingBar);

    // Left and right luminous pylons
    const postGeom = new THREE.CylinderGeometry(0.12, 0.12, 1.8, 8);
    const postMat = new THREE.MeshBasicMaterial({
      color: 0xffea00,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.leftPost = new THREE.Mesh(postGeom, postMat);
    this.leftPost.position.set(-5.2, 0.9, 0);
    this.rightPost = new THREE.Mesh(postGeom, postMat);
    this.rightPost.position.set(5.2, 0.9, 0);
    this.brakingGroup.add(this.leftPost, this.rightPost);

    // Floating pulsing chevron pointer
    const pointerGeo = new THREE.ConeGeometry(0.5, 1.2, 4);
    pointerGeo.rotateX(Math.PI);
    const pointerMat = new THREE.MeshBasicMaterial({
      color: 0xff3d00,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    this.brakingPointer = new THREE.Mesh(pointerGeo, pointerMat);
    this.brakingPointer.position.y = 1.4;
    this.brakingGroup.add(this.brakingPointer);

    this.group.add(this.brakingGroup);
  }

  /**
   * Main update loop
   */
  update(egoCar, session, line, now = 0, driver = null) {
    if (!this.visible || !egoCar) {
      this.hide();
      return;
    }

    const model = line?.model;
    if (!model) return;

    // 1. Update Opponent Forward Space-Time Predictions
    if (this.showPredictions) {
      this._updateOpponentPredictions(egoCar, session, model);
    } else {
      this.predictionGeometry.setDrawRange(0, 0);
    }

    // 2. Update Illuminated 3D Tactical Corridor Ribbon
    if (this.showCorridors) {
      this._updateTacticalCorridor(egoCar, line, model, driver);
    } else {
      this.corridorGeometry.setDrawRange(0, 0);
      this.corridorMesh.visible = false;
    }

    // 3. Update Dynamic Braking Laser Crossbar
    if (this.showBraking) {
      this._updateBrakingMarker(egoCar, line, model, driver, now);
    } else {
      this.brakingGroup.visible = false;
    }
  }

  _updateOpponentPredictions(egoCar, session, model) {
    const cars = session.activeCars ?? session.cars ?? [];
    const opponents = cars.filter((c) => c !== egoCar && c.speed !== undefined);

    const posAttr = this.predictionGeometry.attributes.position;
    const colAttr = this.predictionGeometry.attributes.color;
    const posArr = posAttr.array;
    const colArr = colAttr.array;

    let vertIndex = 0;
    const hl = this.carDimensions.length * 0.5;
    const hw = this.carDimensions.width * 0.5;
    const h = this.carDimensions.height;
    const elevation = 0.22;

    const oppCount = Math.min(MAX_OPPONENTS, opponents.length);

    for (let i = 0; i < oppCount; i++) {
      const opp = opponents[i];
      const speed = Math.max(0, opp.speed);
      const s0 = opp.s;
      const q0 = opp.lateral;

      let prevCenter = { x: opp.x, y: elevation, z: opp.z };

      for (let hIdx = 0; hIdx < TIME_HORIZONS.length; hIdx++) {
        const dt = TIME_HORIZONS[hIdx];
        const sPred = s0 + speed * dt;
        const pt = model.point(sPred, q0);
        const heading = pt.heading;

        const cosH = Math.cos(heading);
        const sinH = Math.sin(heading);

        // Forward and Right vectors on horizontal plane
        const fx = sinH, fz = cosH;
        const rx = cosH, rz = -sinH;

        const cx = pt.x, cz = pt.z;
        const color = HORIZON_COLORS[hIdx];

        // 8 box corners: 4 bottom, 4 top
        // Corner indices:
        // 0: front-left, 1: front-right, 2: rear-right, 3: rear-left (bottom)
        // 4: front-left, 5: front-right, 6: rear-right, 7: rear-left (top)
        const corners = [
          [cx + fx * hl - rx * hw, elevation, cz + fz * hl - rz * hw],
          [cx + fx * hl + rx * hw, elevation, cz + fz * hl + rz * hw],
          [cx - fx * hl + rx * hw, elevation, cz - fz * hl + rz * hw],
          [cx - fx * hl - rx * hw, elevation, cz - fz * hl - rz * hw],
          [cx + fx * hl - rx * hw, elevation + h, cz + fz * hl - rz * hw],
          [cx + fx * hl + rx * hw, elevation + h, cz + fz * hl + rz * hw],
          [cx - fx * hl + rx * hw, elevation + h, cz - fz * hl + rz * hw],
          [cx - fx * hl - rx * hw, elevation + h, cz - fz * hl - rz * hw],
        ];

        // 12 edges for wireframe box
        const edges = [
          [0, 1], [1, 2], [2, 3], [3, 0], // Bottom
          [4, 5], [5, 6], [6, 7], [7, 4], // Top
          [0, 4], [1, 5], [2, 6], [3, 7], // Vertical struts
        ];

        for (const [a, b] of edges) {
          posArr[vertIndex * 3 + 0] = corners[a][0];
          posArr[vertIndex * 3 + 1] = corners[a][1];
          posArr[vertIndex * 3 + 2] = corners[a][2];
          colArr[vertIndex * 3 + 0] = color.r;
          colArr[vertIndex * 3 + 1] = color.g;
          colArr[vertIndex * 3 + 2] = color.b;
          vertIndex++;

          posArr[vertIndex * 3 + 0] = corners[b][0];
          posArr[vertIndex * 3 + 1] = corners[b][1];
          posArr[vertIndex * 3 + 2] = corners[b][2];
          colArr[vertIndex * 3 + 0] = color.r;
          colArr[vertIndex * 3 + 1] = color.g;
          colArr[vertIndex * 3 + 2] = color.b;
          vertIndex++;
        }

        // Trajectory ray connecting center to forecast
        posArr[vertIndex * 3 + 0] = prevCenter.x;
        posArr[vertIndex * 3 + 1] = prevCenter.y;
        posArr[vertIndex * 3 + 2] = prevCenter.z;
        colArr[vertIndex * 3 + 0] = color.r * 0.7;
        colArr[vertIndex * 3 + 1] = color.g * 0.7;
        colArr[vertIndex * 3 + 2] = color.b * 0.7;
        vertIndex++;

        posArr[vertIndex * 3 + 0] = cx;
        posArr[vertIndex * 3 + 1] = elevation;
        posArr[vertIndex * 3 + 2] = cz;
        colArr[vertIndex * 3 + 0] = color.r;
        colArr[vertIndex * 3 + 1] = color.g;
        colArr[vertIndex * 3 + 2] = color.b;
        vertIndex++;

        prevCenter = { x: cx, y: elevation, z: cz };
      }
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.predictionGeometry.setDrawRange(0, vertIndex);
    this.predictionLines.visible = vertIndex > 0;
  }

  _updateTacticalCorridor(egoCar, line, model, driver) {
    const state = driver?.state ?? {};
    const intent = state.intent ?? 'FREE_AIR';
    const isAttack = ['ATTACK_LEFT', 'ATTACK_RIGHT', 'ATTACK_INSIDE', 'ATTACK_OUTSIDE', 'DIVEBOMB', 'SWITCHBACK', 'INSIDE', 'OUTSIDE'].includes(intent);
    const isDefend = ['DEFEND_LEFT', 'DEFEND_RIGHT', 'DEFEND_INSIDE', 'DEFEND_OUTSIDE', 'BREAK_TOW', 'DEFEND'].includes(intent) || Boolean(state.defending);

    // In clean/free air, hide the tactical ribbon so the road surface remains clean and visible
    if (!isAttack && !isDefend) {
      this.corridorGeometry.setDrawRange(0, 0);
      this.corridorMesh.visible = false;
      return;
    }

    const palette = CORRIDOR_COLORS[intent] || (isDefend ? CORRIDOR_COLORS.DEFEND : CORRIDOR_COLORS.DEFAULT);
    const targetQ = Number.isFinite(state.targetQ) ? state.targetQ : (state.targetOffset ?? egoCar.lateral);

    const posAttr = this.corridorGeometry.attributes.position;
    const colAttr = this.corridorGeometry.attributes.color;
    const posArr = posAttr.array;
    const colArr = colAttr.array;

    const s0 = egoCar.s;
    const L = Math.max(35, Math.min(80, egoCar.speed * 1.8));
    const span = L / CORRIDOR_SEGMENTS;
    const elevation = 0.08;
    const corridorHalfWidth = 2.2;

    let vertIndex = 0;

    for (let k = 0; k < CORRIDOR_SEGMENTS; k++) {
      const sA = s0 + k * span;
      const sB = s0 + (k + 1) * span;

      const ptA = model.point(sA, targetQ);
      const ptB = model.point(sB, targetQ);

      // Left & right bounds across the tactical corridor
      const pA_Lx = ptA.x - ptA.nx * corridorHalfWidth;
      const pA_Lz = ptA.z - ptA.nz * corridorHalfWidth;
      const pA_Rx = ptA.x + ptA.nx * corridorHalfWidth;
      const pA_Rz = ptA.z + ptA.nz * corridorHalfWidth;

      const pB_Lx = ptB.x - ptB.nx * corridorHalfWidth;
      const pB_Lz = ptB.z - ptB.nz * corridorHalfWidth;
      const pB_Rx = ptB.x + ptB.nx * corridorHalfWidth;
      const pB_Rz = ptB.z + ptB.nz * corridorHalfWidth;

      const fadeA = 1.0 - k / CORRIDOR_SEGMENTS;
      const fadeB = 1.0 - (k + 1) / CORRIDOR_SEGMENTS;

      const cA_r = palette.base.r * fadeA, cA_g = palette.base.g * fadeA, cA_b = palette.base.b * fadeA;
      const cB_r = palette.top.r * fadeB,  cB_g = palette.top.g * fadeB,  cB_b = palette.top.b * fadeB;

      // Triangle 1: pA_L, pA_R, pB_L
      posArr[vertIndex * 3 + 0] = pA_Lx; posArr[vertIndex * 3 + 1] = elevation; posArr[vertIndex * 3 + 2] = pA_Lz;
      colArr[vertIndex * 3 + 0] = cA_r;  colArr[vertIndex * 3 + 1] = cA_g;      colArr[vertIndex * 3 + 2] = cA_b;
      vertIndex++;

      posArr[vertIndex * 3 + 0] = pA_Rx; posArr[vertIndex * 3 + 1] = elevation; posArr[vertIndex * 3 + 2] = pA_Rz;
      colArr[vertIndex * 3 + 0] = cA_r;  colArr[vertIndex * 3 + 1] = cA_g;      colArr[vertIndex * 3 + 2] = cA_b;
      vertIndex++;

      posArr[vertIndex * 3 + 0] = pB_Lx; posArr[vertIndex * 3 + 1] = elevation; posArr[vertIndex * 3 + 2] = pB_Lz;
      colArr[vertIndex * 3 + 0] = cB_r;  colArr[vertIndex * 3 + 1] = cB_g;      colArr[vertIndex * 3 + 2] = cB_b;
      vertIndex++;

      // Triangle 2: pA_R, pB_R, pB_L
      posArr[vertIndex * 3 + 0] = pA_Rx; posArr[vertIndex * 3 + 1] = elevation; posArr[vertIndex * 3 + 2] = pA_Rz;
      colArr[vertIndex * 3 + 0] = cA_r;  colArr[vertIndex * 3 + 1] = cA_g;      colArr[vertIndex * 3 + 2] = cA_b;
      vertIndex++;

      posArr[vertIndex * 3 + 0] = pB_Rx; posArr[vertIndex * 3 + 1] = elevation; posArr[vertIndex * 3 + 2] = pB_Rz;
      colArr[vertIndex * 3 + 0] = cB_r;  colArr[vertIndex * 3 + 1] = cB_g;      colArr[vertIndex * 3 + 2] = cB_b;
      vertIndex++;

      posArr[vertIndex * 3 + 0] = pB_Lx; posArr[vertIndex * 3 + 1] = elevation; posArr[vertIndex * 3 + 2] = pB_Lz;
      colArr[vertIndex * 3 + 0] = cB_r;  colArr[vertIndex * 3 + 1] = cB_g;      colArr[vertIndex * 3 + 2] = cB_b;
      vertIndex++;
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.corridorGeometry.setDrawRange(0, vertIndex);
    this.corridorMesh.visible = true;
  }

  _updateBrakingMarker(egoCar, line, model, driver, now) {
    const currentSpeed = finite(egoCar.speed);
    const state = driver?.state ?? {};
    const targetSpeed = finite(state.targetSpeed, currentSpeed);
    const speedDelta = currentSpeed - targetSpeed;
    const trackLen = model.length;

    let brakeDist = null;
    if (speedDelta > 3.5 && currentSpeed > 15) {
      const aBrake = 14.5;
      brakeDist = Math.max(2, (currentSpeed * currentSpeed - targetSpeed * targetSpeed) / (2 * aBrake));
    } else if (line?.brakeEvents?.length) {
      for (const ev of line.brakeEvents) {
        let dist = ev.startS - egoCar.s;
        if (dist < -10) dist += trackLen;
        if (dist >= -5 && dist < 120) {
          brakeDist = dist;
          break;
        }
      }
    }

    if (brakeDist === null || brakeDist > 140) {
      this.brakingGroup.visible = false;
      return;
    }

    const targetS = (egoCar.s + brakeDist) % trackLen;
    const pt = model.point(targetS, 0);
    this.brakingGroup.position.set(pt.x, 0.05, pt.z);
    this.brakingGroup.rotation.y = -pt.heading + Math.PI / 2;
    this.brakingGroup.visible = true;

    // Pulse braking pointer height and bar intensity
    const pulse = 1.0 + Math.sin(now * 0.012) * 0.25;
    this.brakingPointer.position.y = 1.3 + pulse * 0.35;
    const urgency = clamp(1.0 - brakeDist / 55, 0, 1);
    this.brakingBar.material.color.setRGB(1.0, 0.2 + 0.6 * (1 - urgency), 0.3);
    this.brakingBar.material.opacity = 0.75 + 0.25 * urgency;
  }

  hide() {
    this.predictionGeometry.setDrawRange(0, 0);
    this.corridorGeometry.setDrawRange(0, 0);
    this.brakingGroup.visible = false;
  }

  setVisible(val) {
    this.visible = val;
    this.group.visible = val;
  }
}
