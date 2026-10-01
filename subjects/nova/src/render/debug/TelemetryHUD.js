const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const HUD_STYLES = `
.ds-telemetry-overlay {
  position: fixed;
  bottom: 18px;
  right: 18px;
  width: 440px;
  background: rgba(6, 14, 22, 0.94);
  border: 1px solid rgba(0, 240, 255, 0.35);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.85), inset 0 0 16px rgba(0, 240, 255, 0.08);
  border-radius: 8px;
  color: #e0f7fa;
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
  font-size: 11px;
  line-height: 1.35;
  z-index: 9999;
  backdrop-filter: blur(10px);
  pointer-events: auto;
  user-select: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  box-sizing: border-box;
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.ds-telemetry-overlay.collapsed .ds-telemetry-body {
  display: none !important;
}

.ds-telemetry-overlay.hidden {
  display: none !important;
}

.ds-telemetry-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid rgba(0, 240, 255, 0.25);
  padding-bottom: 6px;
}

.ds-telemetry-title {
  font-weight: 800;
  font-size: 11.5px;
  color: #00f0ff;
  letter-spacing: 1px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.ds-telemetry-badge {
  background: rgba(0, 240, 255, 0.15);
  border: 1px solid #00f0ff;
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 9px;
  color: #00f0ff;
}

.ds-header-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.ds-btn {
  background: rgba(0, 240, 255, 0.15);
  border: 1px solid rgba(0, 240, 255, 0.4);
  color: #00f0ff;
  border-radius: 4px;
  padding: 2px 7px;
  font-size: 9px;
  cursor: pointer;
  font-family: inherit;
  font-weight: 700;
}
.ds-btn:hover {
  background: rgba(0, 240, 255, 0.3);
}

.ds-telemetry-grid-top {
  display: grid;
  grid-template-columns: 130px 1fr;
  gap: 10px;
}

.ds-gg-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  background: rgba(0, 0, 0, 0.45);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 6px;
}

.ds-gg-canvas {
  width: 118px;
  height: 118px;
  border-radius: 4px;
}

.ds-gg-readout {
  font-size: 9px;
  color: #80deea;
  margin-top: 4px;
  text-align: center;
  width: 100%;
}

.ds-status-panel {
  background: rgba(0, 0, 0, 0.45);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ds-mode-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.ds-mode-tag {
  font-weight: 800;
  font-size: 10.5px;
  padding: 2px 6px;
  border-radius: 3px;
  background: #00f0ff;
  color: #000;
  letter-spacing: 0.5px;
}

.ds-metrics-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px 8px;
  margin-top: 4px;
  font-size: 9.5px;
}
.ds-metrics-grid span {
  color: #90a4ae;
}
.ds-metrics-grid b {
  color: #fff;
}

.ds-bars-panel {
  background: rgba(0, 0, 0, 0.45);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.ds-bar-group {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 9.5px;
}
.ds-bar-label {
  width: 52px;
  color: #90a4ae;
}
.ds-bar-track {
  flex: 1;
  height: 7px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  overflow: hidden;
  position: relative;
}
.ds-bar-fill {
  height: 100%;
  width: 0%;
  border-radius: 3px;
  transition: width 0.05s linear;
}
.ds-bar-fill.throttle { background: #00ff88; }
.ds-bar-fill.brake { background: #ff3355; }
.ds-bar-val {
  width: 48px;
  text-align: right;
  color: #fff;
  font-weight: 700;
}

.ds-steer-track {
  flex: 1;
  height: 7px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  position: relative;
}
.ds-steer-center {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(255, 255, 255, 0.4);
}
.ds-steer-marker {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 4px;
  background: #00f0ff;
  border-radius: 2px;
  transform: translateX(-50%);
  left: 50%;
}

.ds-layer-toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 6px 8px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  font-size: 9px;
  color: #b0bec5;
}
.ds-layer-toggles label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.ds-layer-toggles input {
  accent-color: #00f0ff;
  cursor: pointer;
  margin: 0;
}

.ds-select-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 9px;
  color: #90a4ae;
}
.ds-select-row select {
  background: #0f1c24;
  color: #e0f7fa;
  border: 1px solid rgba(0, 240, 255, 0.3);
  padding: 3px 6px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 9px;
}

@media (max-width: 760px) {
  .ds-telemetry-overlay {
    width: min(340px, calc(100vw - 16px));
    right: 8px;
    bottom: 8px;
  }
  .ds-telemetry-grid-top {
    grid-template-columns: 1fr;
  }
}
`;

/**
 * High-Performance Cyberpunk Telemetry HUD Overlay
 * Features live G-G friction circle with history trail, vehicle dynamics bars,
 * decision readout, and layer toggles.
 */
export class TelemetryHUD {
  constructor(options = {}) {
    this.visible = true;
    this.collapsed = false;
    this.historyCapacity = options.historyCapacity ?? 45;
    this.ggHistory = [];
    this.lastDomUpdate = 0;
    this.domUpdateInterval = 50; // 20Hz DOM refresh

    this.layerToggles = {
      ribbon: true,
      candidates: true,
      corridors: true,
      predictions: true,
      braking: true,
      thought: true,
      gg: true,
    };

    this.onLayerChange = null;
    this.onCarSelect = null;

    this._initDOM();
    this._initCanvas();
  }

  _initDOM() {
    if (typeof document === 'undefined') return;

    if (!document.getElementById('ds-telemetry-hud-styles')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'ds-telemetry-hud-styles';
      styleEl.textContent = HUD_STYLES;
      document.head.appendChild(styleEl);
    }

    this.root = document.createElement('div');
    this.root.className = 'ds-telemetry-overlay';
    this.root.id = 'ai-debug';
    this.root.innerHTML = `
      <div class="ds-telemetry-header debug-header">
        <div class="ds-telemetry-title">
          <span>🧠 DEEPSEEK RACE ENGINEER</span>
          <span class="ds-telemetry-badge" id="ds-hud-vehicle-tag">GT #1</span>
        </div>
        <div class="ds-header-actions">
          <button type="button" class="ds-btn" id="ds-btn-collapse" title="Collapse/Expand">_</button>
          <button type="button" class="ds-btn" id="ds-btn-close" aria-label="close" title="Hide Debugger (B)">×</button>
        </div>
      </div>

      <div class="ds-telemetry-body" style="display: flex; flex-direction: column; gap: 8px;">
        <div class="ds-select-row debug-select">
          <label>FOCUSED CAR <select id="debug-car"></select></label>
          <button type="button" class="ds-btn debug-camera" id="ds-cam-toggle">CAMERA</button>
        </div>

        <div class="ds-telemetry-grid-top">
          <div class="ds-gg-panel" id="ds-gg-container">
            <canvas class="ds-gg-canvas" id="ds-gg-canvas" width="118" height="118"></canvas>
            <div class="ds-gg-readout" id="ds-gg-readout">0.00G LAT | 0.00G LONG</div>
          </div>

          <div class="ds-status-panel">
            <div class="ds-mode-row">
              <span class="ds-mode-tag" id="ds-thought-mode">PACE</span>
              <span id="ds-thought-target" style="color: #90a4ae; font-size: 9px;">FREE AIR</span>
            </div>
            <div id="debug-reason" style="font-size: 9.5px; color: #ffeb3b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              Tracking racing line baseline
            </div>

            <div class="ds-metrics-grid">
              <div><span>SPEED:</span> <b id="debug-speed">0 km/h</b></div>
              <div><span>TARGET:</span> <b id="debug-target">--</b></div>
              <div><span>LINE ERR:</span> <b id="debug-rlat">0.00 m</b></div>
              <div><span>HEADING:</span> <b id="debug-rhead">0.0°</b></div>
              <div><span>LAP:</span> <b id="debug-lap">--</b></div>
              <div><span>PLAN LAP:</span> <b id="debug-plan">--</b></div>
              <div><span>PEAK GRIP:</span> <b id="debug-grip">--</b></div>
              <div><span>STATUS:</span> <b id="ds-status-text" style="color: #00ff88;">OPTIMAL</b></div>
            </div>
          </div>
        </div>

        <div class="ds-bars-panel">
          <div class="ds-bar-group">
            <span class="ds-bar-label">THROTTLE</span>
            <div class="ds-bar-track"><div class="ds-bar-fill throttle" id="ds-bar-thr"></div></div>
            <span class="ds-bar-val" id="ds-val-thr">0%</span>
          </div>
          <div class="ds-bar-group">
            <span class="ds-bar-label">BRAKE</span>
            <div class="ds-bar-track"><div class="ds-bar-fill brake" id="ds-bar-brk"></div></div>
            <span class="ds-bar-val" id="ds-val-brk">0%</span>
          </div>
          <div class="ds-bar-group">
            <span class="ds-bar-label">STEERING</span>
            <div class="ds-steer-track">
              <div class="ds-steer-center"></div>
              <div class="ds-steer-marker" id="ds-steer-marker"></div>
            </div>
            <span class="ds-bar-val" id="ds-val-str">0.0°</span>
          </div>
        </div>

        <div class="ds-layer-toggles">
          <label><input type="checkbox" id="ds-tog-ribbon" checked> Ribbon</label>
          <label><input type="checkbox" id="ds-tog-candidates" checked> Candidates</label>
          <label><input type="checkbox" id="ds-tog-corridors" checked> Corridors</label>
          <label><input type="checkbox" id="ds-tog-predictions" checked> Predictions</label>
          <label><input type="checkbox" id="ds-tog-braking" checked> Braking</label>
          <label><input type="checkbox" id="ds-tog-thought" checked> 3D Thought</label>
          <label><input type="checkbox" id="ds-tog-gg" checked> G-G Circle</label>
        </div>
      </div>
    `;

    const host = document.querySelector('#app') ?? document.body;
    host.appendChild(this.root);

    // Setup events
    this.root.querySelector('#ds-btn-collapse').onclick = () => {
      this.collapsed = !this.collapsed;
      this.root.classList.toggle('collapsed', this.collapsed);
      this.root.querySelector('#ds-btn-collapse').textContent = this.collapsed ? '□' : '_';
    };

    const attachToggle = (id, key) => {
      const el = this.root.querySelector(`#${id}`);
      if (!el) return;
      el.onchange = () => {
        this.layerToggles[key] = el.checked;
        if (key === 'gg') {
          const ggCont = this.root.querySelector('#ds-gg-container');
          if (ggCont) ggCont.style.display = el.checked ? 'flex' : 'none';
        }
        if (this.onLayerChange) this.onLayerChange(key, el.checked);
      };
    };

    attachToggle('ds-tog-ribbon', 'ribbon');
    attachToggle('ds-tog-candidates', 'candidates');
    attachToggle('ds-tog-corridors', 'corridors');
    attachToggle('ds-tog-predictions', 'predictions');
    attachToggle('ds-tog-braking', 'braking');
    attachToggle('ds-tog-thought', 'thought');
    attachToggle('ds-tog-gg', 'gg');
  }

  _initCanvas() {
    if (!this.root) return;
    this.canvas = this.root.querySelector('#ds-gg-canvas');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
  }

  update(car, driver, line, now = 0) {
    if (!this.visible || !car) return;

    // Update G-G friction history
    const latG = (car.ay ?? 0) / 9.81;
    const longG = (car.ax ?? 0) / 9.81;
    this.ggHistory.push({ lat: latG, long: longG, time: now });
    if (this.ggHistory.length > this.historyCapacity) {
      this.ggHistory.shift();
    }

    if (this.layerToggles.gg && this.ctx) {
      this._renderGGCanvas(latG, longG);
    }

    if (now - this.lastDomUpdate >= this.domUpdateInterval) {
      this.lastDomUpdate = now;
      this._updateDOM(car, driver, line);
    }
  }

  _renderGGCanvas(latG, longG) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const maxG = 1.6;
    const scale = (w * 0.42) / maxG;

    ctx.clearRect(0, 0, w, h);

    // Background & crosshairs
    ctx.fillStyle = 'rgba(4, 12, 18, 0.85)';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 4); ctx.lineTo(cx, h - 4);
    ctx.moveTo(4, cy); ctx.lineTo(w - 4, cy);
    ctx.stroke();

    // 1.0G reference circle
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.4)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, 1.0 * scale, 0, Math.PI * 2);
    ctx.stroke();

    // 1.4G limit circle
    ctx.strokeStyle = 'rgba(255, 51, 85, 0.35)';
    ctx.beginPath();
    ctx.arc(cx, cy, 1.4 * scale, 0, Math.PI * 2);
    ctx.stroke();

    // Fading G history trail
    const n = this.ggHistory.length;
    for (let i = 0; i < n; i++) {
      const alpha = (i / n) * 0.6;
      const pt = this.ggHistory[i];
      const px = cx + pt.lat * scale;
      const py = cy - pt.long * scale;

      ctx.fillStyle = `rgba(0, 240, 255, ${alpha.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(px, py, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Live instant G point
    const liveX = clamp(cx + latG * scale, 4, w - 4);
    const liveY = clamp(cy - longG * scale, 4, h - 4);
    const isPeak = Math.hypot(latG, longG) > 1.25;

    ctx.fillStyle = isPeak ? '#ff3355' : '#00ff88';
    ctx.shadowColor = isPeak ? '#ff3355' : '#00ff88';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(liveX, liveY, 3.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    const readout = this.root.querySelector('#ds-gg-readout');
    if (readout) {
      readout.textContent = `${Math.abs(latG).toFixed(2)}G LAT | ${longG >= 0 ? '+' : ''}${longG.toFixed(2)}G LONG`;
    }
  }

  _updateDOM(car, driver, line) {
    if (!this.root || !car) return;
    const state = driver?.state ?? {};
    const speed = car.speed * 3.6;
    const target = (state.targetSpeed ?? 0) * 3.6;
    const lap = car.race?.lastLap ?? null;
    const best = car.race?.bestLap ?? null;
    const rlat = finite(state.rlat, 0);
    const rhead = finite(state.rhead, 0);

    const set = (id, text) => {
      const el = this.root.querySelector(`#${id}`);
      if (el) el.textContent = text;
    };

    set('ds-hud-vehicle-tag', `${car.name} // ${(car.classId ?? 'GT').toUpperCase()}`);
    set('debug-speed', `${speed.toFixed(0)} km/h`);
    set('debug-target', target ? `${target.toFixed(0)} km/h` : '--');
    set('debug-rlat', `${rlat.toFixed(2)} m`);
    set('debug-rhead', `${((rhead * 180) / Math.PI).toFixed(1)}°`);
    set('debug-lap', lap ? `${lap.toFixed(3)} s` : '--');
    set('debug-plan', line ? `${line.time.toFixed(3)} s` : '--');
    set('debug-grip', `${(Math.abs(car.ay ?? 0) / 9.81).toFixed(2)} g`);
    set('ds-thought-mode', state.intent ?? 'PACE');
    set('ds-thought-target', state.cause ?? (state.plannedBrake ? 'PLANNED_BRAKE' : 'FREE_AIR'));
    set('ds-status-text', state.supervisor ? state.supervisor : 'OPTIMAL');

    const statusEl = this.root.querySelector('#ds-status-text');
    if (statusEl) {
      statusEl.style.color = state.supervisor ? '#ff5252' : '#00ff88';
    }

    // Pedals & steering
    const thrPct = clamp((car.controls?.throttle ?? 0) * 100, 0, 100);
    const brkPct = clamp((car.controls?.brake ?? 0) * 100, 0, 100);
    const steerDeg = clamp((car.steering ?? 0) * (180 / Math.PI), -40, 40);

    const barThr = this.root.querySelector('#ds-bar-thr');
    if (barThr) barThr.style.width = `${thrPct.toFixed(0)}%`;
    set('ds-val-thr', `${thrPct.toFixed(0)}%`);

    const barBrk = this.root.querySelector('#ds-bar-brk');
    if (barBrk) barBrk.style.width = `${brkPct.toFixed(0)}%`;
    set('ds-val-brk', `${brkPct.toFixed(0)}%`);

    const steerMarker = this.root.querySelector('#ds-steer-marker');
    if (steerMarker) {
      const steerNorm = (steerDeg / 40) * 50; // -50% to +50%
      steerMarker.style.left = `${50 + steerNorm}%`;
    }
    set('ds-val-str', `${steerDeg >= 0 ? '+' : ''}${steerDeg.toFixed(1)}°`);

    // Reason text
    const reasonEl = this.root.querySelector('#debug-reason');
    if (reasonEl) {
      reasonEl.textContent = this._explain(car, state, line, best);
    }
  }

  _explain(car, state, line, best) {
    const bits = [];
    const speed = car.speed;
    const target = state.targetSpeed ?? 0;
    if (state.supervisor) bits.push(`Safety supervisor active: ${state.supervisor}.`);
    else if (state.intent === 'RECOVER') bits.push('Recovering: rejoining race line.');
    else if (state.brakeReason && state.brakeReason !== 'NONE') bits.push(`Brake [${state.brakeReason}]: ${(state.brakingMarginMeters ?? 0).toFixed(0)}m margin to ${(target * 3.6).toFixed(0)} km/h.`);
    else if (state.plannedBrake) bits.push('Planned braking zone: threshold decel.');
    else if (state.throttleLimitReason && state.throttleLimitReason !== 'NONE') bits.push(`Thr limit [${state.throttleLimitReason}]: ${(state.throttle * 100).toFixed(0)}% (tgt ${(target * 3.6).toFixed(0)} km/h).`);
    else if (target > speed + 0.5) bits.push(`Full throttle towards ${(target * 3.6).toFixed(0)} km/h.`);
    else if (target < speed - 1.5) bits.push('Lifting / trailing for corner entry.');
    else bits.push('On nominal trajectory pace.');

    if (Math.abs(state.rlat ?? 0) > 0.35) bits.push(`Tracking ${(state.rlat ?? 0).toFixed(2)}m lateral offset.`);
    return bits.join(' ');
  }

  setVisible(val) {
    this.visible = val;
    if (this.root) this.root.classList.toggle('hidden', !val);
  }
}
