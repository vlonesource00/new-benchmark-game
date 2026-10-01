import * as THREE from 'three';

const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/**
 * 3D Floating Thought Billboard Sprite
 * Displays live AI decision state, current plan, safety clearance, and lateral error
 * directly above the vehicle roof using a throttled dynamic canvas texture.
 */
export class FloatingThoughtSprite {
  constructor(parentGroup, options = {}) {
    this.group = new THREE.Group();
    this.group.name = 'DEEPSEEK_FLOATING_THOUGHT';
    this.visible = true;

    this.yOffset = options.yOffset ?? 3.35;
    this.scale = options.scale ?? [6.4, 1.92, 1];
    this.updateIntervalMs = options.updateIntervalMs ?? 110;

    this.signature = '';
    this.lastUpdateAt = -Infinity;

    this._initSprite();

    if (parentGroup) {
      parentGroup.add(this.group);
    }
  }

  _initSprite() {
    if (typeof document === 'undefined') return;

    this.canvas = document.createElement('canvas');
    this.canvas.width = 640;
    this.canvas.height = 192;
    this.context = this.canvas.getContext('2d');

    if (!this.context) return;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;

    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.sprite = new THREE.Sprite(this.material);
    this.sprite.name = 'AI_OVERHEAD_THOUGHT_SPRITE';
    this.sprite.renderOrder = 300;
    this.sprite.visible = false;
    this.sprite.scale.set(this.scale[0], this.scale[1], this.scale[2]);

    this.group.add(this.sprite);
  }

  update(car, driver, line, now = 0) {
    if (!this.visible || !this.sprite || !car) {
      if (this.sprite) this.sprite.visible = false;
      return;
    }

    const state = driver?.state ?? {};
    const intent = state.intent ?? (state.plannedBrake ? 'BRAKE' : 'PACE');
    const mode = state.mode ?? 'NOVA';
    let cause = state.cause;
    if (!cause) {
      if (state.brake > 0.05 || state.plannedBrake) {
        cause = 'THRESHOLD_BRAKING';
      } else if (state.throttle > 0.95) {
        cause = 'WOT_ACCELERATION';
      } else if (Math.abs(finite(state.rlat, 0)) > 0.5) {
        cause = 'APEX_APPROACH';
      } else {
        cause = intent === 'FREE_AIR' ? 'TIME_OPTIMAL_APEX' : 'RACE_PACE';
      }
    }
    const supervisor = state.supervisor ?? 'NOMINAL';
    const rlat = finite(state.rlat, 0);
    const speed = finite(car.speed * 3.6, 0);
    const target = finite((state.targetSpeed ?? 0) * 3.6, 0);
    const isSafe = !state.supervisor;

    const signature = `${car.name}|${intent}|${mode}|${cause}|${supervisor}|${rlat.toFixed(2)}|${speed.toFixed(0)}|${target.toFixed(0)}`;

    if (signature !== this.signature && now - this.lastUpdateAt >= this.updateIntervalMs) {
      this.signature = signature;
      this.lastUpdateAt = now;
      this._renderCanvas(car, intent, mode, cause, supervisor, rlat, speed, target, isSafe);
    }

    this.sprite.position.set(car.x, (car.y ?? 0) + this.yOffset, car.z);
    this.sprite.visible = true;
  }

  _renderCanvas(car, intent, mode, cause, supervisor, rlat, speed, target, isSafe) {
    const ctx = this.context;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Dark cyberpunk translucent card
    ctx.fillStyle = 'rgba(6, 14, 22, 0.92)';
    ctx.strokeStyle = isSafe ? '#00f0ff' : '#ff3355';
    ctx.lineWidth = 3.5;
    ctx.fillRect(2, 2, w - 4, h - 4);
    ctx.strokeRect(3, 3, w - 6, h - 6);

    // Vehicle Badge Header
    ctx.font = '700 24px Consolas, monospace';
    ctx.fillStyle = '#00ff88';
    ctx.fillText(`${car.name} // ${(car.classId ?? 'GT').toUpperCase()}`, 18, 36);

    // Intent & Plan Tag
    ctx.font = '700 22px Consolas, monospace';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`PLAN: ${intent} [${mode}]`, 18, 72);

    // State & Safety Status
    ctx.font = '700 20px Consolas, monospace';
    ctx.fillStyle = isSafe ? '#00f0ff' : '#ff5252';
    ctx.fillText(`STATE: ${supervisor === 'NOMINAL' ? 'COLLISION FREE' : supervisor}`, 18, 108);

    // Dynamics Readouts
    ctx.font = '600 18px Consolas, monospace';
    ctx.fillStyle = '#90a4ae';
    ctx.fillText(`SPD: ${speed.toFixed(0)} KM/H (TGT: ${target ? target.toFixed(0) : '--'})`, 18, 142);
    ctx.fillText(`LAT ERR: ${rlat.toFixed(2)}M | REASON: ${cause.slice(0, 24)}`, 18, 172);

    this.texture.needsUpdate = true;
  }

  hide() {
    if (this.sprite) this.sprite.visible = false;
  }

  setVisible(val) {
    this.visible = val;
    this.group.visible = val;
  }
}
