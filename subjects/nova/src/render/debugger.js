// DeepSeek AI Debug Suite & Race Engineer
// 3.8 Flash Gemini Gauntlet-aligned Visual Telemetry Architecture:
// - 3D chosen local trajectory ribbon with vertex speed-gradient coloring
// - Frenet candidate spline lattice fan ("all possible paths") categorized by viability
// - Space-time opponent prediction bounding boxes & trajectory rays (0.5s - 3.0s)
// - 3D illuminated tactical road corridors and dynamic laser braking crossbars
// - Overhead 3D floating thought billboard sprite
// - Live G-G friction circle canvas & high-density cyberpunk telemetry HUD

import * as THREE from 'three';
import { CandidateSplineRenderer } from './debug/CandidateSplineRenderer.js';
import { TacticalZoneRenderer } from './debug/TacticalZoneRenderer.js';
import { FloatingThoughtSprite } from './debug/FloatingThoughtSprite.js';
import { TelemetryHUD } from './debug/TelemetryHUD.js';

export class AIDebugger {
  constructor(scene, session, onToggleCamera = null) {
    this.scene = scene;
    this.session = session;
    this.onToggleCamera = onToggleCamera;

    this.enabled = false;
    this.pathsEnabled = true;
    this.keepPaths = false;
    this.focus = 0;

    // Master Three.js Scene Root
    this.root = new THREE.Group();
    this.root.name = 'DEEPSEEK_AI_DEBUG_SUITE_MASTER';
    this.root.visible = false;
    scene.add(this.root);

    // Sub-renderers
    this.candidateRenderer = new CandidateSplineRenderer(this.root);
    this.tacticalRenderer = new TacticalZoneRenderer(this.root);
    this.thoughtSprite = new FloatingThoughtSprite(this.root);
    this.telemetryHUD = new TelemetryHUD();

    // Preserve panel reference for main.js DOM hooks
    this.panel = this.telemetryHUD.root;

    // Driven historical breadcrumb trace line
    this._initTraceLine();

    // Wire HUD callbacks
    this._setupHUDConnections();

    // Populate car choices in HUD
    this._populateCarSelect();
  }

  _initTraceLine() {
    this.tracePoints = 600;
    this.traceCursor = 0;
    this.tracePositions = new Float32Array(this.tracePoints * 3);
    const traceGeom = new THREE.BufferGeometry();
    traceGeom.setAttribute('position', new THREE.BufferAttribute(this.tracePositions, 3));
    traceGeom.setDrawRange(0, 0);

    const traceMat = new THREE.LineBasicMaterial({
      color: 0x00f0ff,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    });

    this.traceLine = new THREE.Line(traceGeom, traceMat);
    this.traceLine.name = 'AI_DRIVEN_TRACE_BREADCRUMBS';
    this.traceLine.frustumCulled = false;
    this.root.add(this.traceLine);
  }

  _setupHUDConnections() {
    if (!this.telemetryHUD) return;

    // Camera toggle button in HUD
    const camBtn = this.panel?.querySelector('#ds-cam-toggle');
    if (camBtn && this.onToggleCamera) {
      camBtn.onclick = () => this.onToggleCamera();
    }

    // Close button (X)
    const closeBtn = this.panel?.querySelector('#ds-btn-close');
    if (closeBtn) {
      closeBtn.onclick = () => this.toggle(false);
    }

    // Layer toggles callback
    this.telemetryHUD.onLayerChange = (key, enabled) => {
      if (key === 'ribbon') {
        this.candidateRenderer.showRibbon = enabled;
      } else if (key === 'candidates') {
        this.candidateRenderer.showCandidates = enabled;
      } else if (key === 'corridors') {
        this.tacticalRenderer.showCorridors = enabled;
      } else if (key === 'predictions') {
        this.tacticalRenderer.showPredictions = enabled;
      } else if (key === 'braking') {
        this.tacticalRenderer.showBraking = enabled;
      } else if (key === 'thought') {
        this.thoughtSprite.visible = enabled;
      }
    };
  }

  _populateCarSelect() {
    const select = this.panel?.querySelector('#debug-car');
    if (!select || !this.session?.cars) return;

    select.innerHTML = '';
    this.session.cars.forEach((car, i) => {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = car.name;
      select.appendChild(option);
    });

    select.value = String(this.focus);
    select.onchange = () => {
      this.focus = Number(select.value);
      this.traceCursor = 0;
      this.traceLine.geometry.setDrawRange(0, 0);
    };
  }

  planFor(car) {
    return this.session.lineFor ? this.session.lineFor(car) : null;
  }

  ensurePanel() {
    if (!this.panel && this.telemetryHUD) {
      this.panel = this.telemetryHUD.root;
    }
    return this.panel;
  }

  toggle(force) {
    this.enabled = force ?? !this.enabled;
    this.root.visible = this.enabled && this.pathsEnabled;
    if (this.telemetryHUD) {
      this.telemetryHUD.setVisible(this.enabled);
    }
    if (this.panel) {
      this.panel.hidden = !this.enabled;
    }
    this.traceCursor = 0;
    this.traceLine.geometry.setDrawRange(0, 0);
    return this.enabled;
  }

  update(now = 0) {
    if (!this.enabled) return;

    const car = this.session.cars[this.focus] ?? this.session.player;
    const driver = this.session.drivers[this.focus];
    const line = this.planFor(car);

    // Update 3D visual renderers if paths are enabled
    if (this.pathsEnabled && car) {
      this.candidateRenderer.update(car, driver, line, now);
      this.tacticalRenderer.update(car, this.session, line, now, driver);
      this.thoughtSprite.update(car, driver, line, now);
      this._updateTraceLine(car);
    } else {
      this.candidateRenderer.hide();
      this.tacticalRenderer.hide();
      this.thoughtSprite.hide();
    }

    // Update 2D Telemetry HUD & G-G canvas
    if (car && this.telemetryHUD) {
      this.telemetryHUD.update(car, driver, line, now);
    }
  }

  _updateTraceLine(car) {
    const idx = this.traceCursor % this.tracePoints;
    this.tracePositions[idx * 3 + 0] = car.x;
    this.tracePositions[idx * 3 + 1] = 0.12;
    this.tracePositions[idx * 3 + 2] = car.z;
    this.traceCursor++;

    const count = Math.min(this.traceCursor, this.tracePoints);
    this.traceLine.geometry.setDrawRange(0, count);
    this.traceLine.geometry.attributes.position.needsUpdate = true;
    this.traceLine.geometry.computeBoundingSphere();
  }
}
