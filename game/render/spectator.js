import * as THREE from 'three';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Universal Spectator & Chase Camera Rig.
 * Supports:
 * - Smooth dynamic Chase Camera behind selected car
 * - Bumper / Bonnet Camera
 * - Free-flight No-clip Spectator Camera
 */
export class SpectatorCamera {
  constructor(camera, element, initialTarget = null) {
    this.camera = camera;
    this.element = element;
    this.targetVehicle = initialTarget;
    this.mode = initialTarget ? 'chase' : 'free'; // 'chase' | 'bonnet' | 'free'

    this.keys = new Set();
    this.yaw = -0.62;
    this.pitch = -0.25;
    this.speed = 55;
    this.position = new THREE.Vector3(125, 72, 170);
    this.lookTarget = new THREE.Vector3(0, 0, 0);
    this.forward = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.move = new THREE.Vector3();

    this.targetPos = new THREE.Vector3();
    this.targetForward = new THREE.Vector3();
    this.desiredPos = new THREE.Vector3();
    this.desiredLook = new THREE.Vector3();
    this.smoothedYaw = 0;

    this._onKeyDown = (event) => {
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
        if (this.mode === 'free') event.preventDefault();
      }
      this.keys.add(event.code);
    };
    this._onKeyUp = (event) => this.keys.delete(event.code);
    this._onMouseMove = (event) => {
      if (document.pointerLockElement !== this.element) return;
      if (this.mode === 'free') {
        this.yaw -= event.movementX * 0.0021;
        this.pitch = clamp(this.pitch - event.movementY * 0.0017, -1.45, 1.45);
      }
    };
    this._onClick = () => {
      if (this.mode === 'free') this.element.requestPointerLock?.();
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('mousemove', this._onMouseMove);
    this.element.addEventListener('click', this._onClick);

    if (this.targetVehicle) this.snapToTarget();
    else this.update(0);
  }

  setTarget(vehicle, mode = 'chase') {
    this.targetVehicle = vehicle;
    this.mode = mode;
    this.snapToTarget();
  }

  setMode(mode) {
    this.mode = mode;
    if (this.mode !== 'free' && this.targetVehicle) {
      this.snapToTarget();
    }
  }

  toggleMode() {
    const cycle = ['chase', 'elevated', 'tactical', 'bonnet', 'free'];
    const idx = cycle.indexOf(this.mode);
    this.mode = cycle[(idx + 1) % cycle.length];
    if (this.mode !== 'free' && this.targetVehicle) {
      this.snapToTarget();
    }
    return this.mode;
  }

  _carPos(v) {
    return {
      x: v.position ? v.position.x : (v.x ?? 0),
      y: v.position ? v.position.y : (v.y ?? 0),
      z: v.position ? v.position.z : (v.z ?? 0)
    };
  }

  snapToTarget() {
    if (!this.targetVehicle) return;
    const v = this.targetVehicle;
    const p = this._carPos(v);
    const yaw = v.yaw ?? 0;
    this.smoothedYaw = yaw;
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const speed = v.speed ?? 0;

    if (this.mode === 'bonnet') {
      this.position.set(p.x + forwardX * 1.6, p.y + 1.15, p.z + forwardZ * 1.6);
      this.lookTarget.set(p.x + forwardX * 25, p.y + 0.8, p.z + forwardZ * 25);
    } else if (this.mode === 'elevated') {
      const dist = 14.5 + Math.min(4.0, speed * 0.05);
      const height = 7.5 + Math.min(2.0, speed * 0.02);
      this.position.set(p.x - forwardX * dist, p.y + height, p.z - forwardZ * dist);
      this.lookTarget.set(p.x + forwardX * 20, p.y + 0.5, p.z + forwardZ * 20);
    } else if (this.mode === 'tactical') {
      this.position.set(p.x - forwardX * 5.0, p.y + 32.0, p.z - forwardZ * 5.0);
      this.lookTarget.set(p.x + forwardX * 16.0, p.y, p.z + forwardZ * 16.0);
    } else {
      // Chase Cam
      const dist = 7.2 + Math.min(2.5, speed * 0.04);
      const height = 2.45 + Math.min(0.6, speed * 0.01);
      this.position.set(p.x - forwardX * dist, p.y + height, p.z - forwardZ * dist);
      this.lookTarget.set(p.x + forwardX * 12, p.y + 1.1, p.z + forwardZ * 12);
    }
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.lookTarget);
  }

  update(dt) {
    const safeDt = Math.min(0.1, dt > 0 ? dt : 1 / 60);

    if ((this.mode === 'chase' || this.mode === 'elevated' || this.mode === 'tactical') && this.targetVehicle) {
      const v = this.targetVehicle;
      const p = this._carPos(v);
      const speed = v.speed ?? 0;
      const yaw = v.yaw ?? 0;

      // Smooth yaw interpolation (avoid 2PI wraparound snaps)
      let dyaw = (yaw - this.smoothedYaw) % (Math.PI * 2);
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      this.smoothedYaw += dyaw * (1 - Math.exp(-8 * safeDt));

      const forwardX = Math.sin(this.smoothedYaw);
      const forwardZ = Math.cos(this.smoothedYaw);

      if (this.mode === 'elevated') {
        const dist = 14.5 + Math.min(4.0, speed * 0.05);
        const height = 7.5 + Math.min(2.0, speed * 0.02);
        this.desiredPos.set(p.x - forwardX * dist, p.y + height, p.z - forwardZ * dist);
        const lookLead = 20 + Math.min(10, speed * 0.25);
        this.desiredLook.set(p.x + forwardX * lookLead, p.y + 0.5, p.z + forwardZ * lookLead);
      } else if (this.mode === 'tactical') {
        this.desiredPos.set(p.x - forwardX * 6.0, p.y + 32.0, p.z - forwardZ * 6.0);
        this.desiredLook.set(p.x + forwardX * 18.0, p.y, p.z + forwardZ * 18.0);
      } else {
        // Standard Chase Cam
        const dist = 7.0 + Math.min(2.2, speed * 0.035);
        const height = 2.4 + Math.min(0.5, speed * 0.01);
        this.desiredPos.set(p.x - forwardX * dist, p.y + height, p.z - forwardZ * dist);
        const lookLead = 12 + Math.min(8, speed * 0.2);
        const vx = v.velocity ? v.velocity.x : (v.vx ?? 0);
        const vz = v.velocity ? v.velocity.z : (v.vz ?? 0);
        this.desiredLook.set(p.x + forwardX * lookLead + vx * 0.12, p.y + 1.1, p.z + forwardZ * lookLead + vz * 0.12);
      }

      this.position.lerp(this.desiredPos, 1 - Math.exp(-14 * safeDt));
      this.lookTarget.lerp(this.desiredLook, 1 - Math.exp(-18 * safeDt));
      this.camera.position.copy(this.position);
      this.camera.lookAt(this.lookTarget);
      return;
    }

    if (this.mode === 'bonnet' && this.targetVehicle) {
      const v = this.targetVehicle;
      const p = this._carPos(v);
      const yaw = v.yaw ?? 0;
      const forwardX = Math.sin(yaw);
      const forwardZ = Math.cos(yaw);
      this.position.set(p.x + forwardX * 1.55, p.y + 1.12, p.z + forwardZ * 1.55);
      this.lookTarget.set(p.x + forwardX * 30, p.y + 0.9, p.z + forwardZ * 30);
      this.camera.position.copy(this.position);
      this.camera.lookAt(this.lookTarget);
      return;
    }

    // Free Spectator Camera
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    this.forward.set(0, 0, -1).applyEuler(this.camera.rotation).normalize();
    this.right.crossVectors(this.forward, this.up).normalize();
    this.move.set(0, 0, 0);
    if (this.keys.has('KeyW')) this.move.add(this.forward);
    if (this.keys.has('KeyS')) this.move.sub(this.forward);
    if (this.keys.has('KeyD')) this.move.add(this.right);
    if (this.keys.has('KeyA')) this.move.sub(this.right);
    if (this.keys.has('KeyE')) this.move.y += 1;
    if (this.keys.has('KeyQ')) this.move.y -= 1;
    if (this.move.lengthSq() > 0) {
      this.move.normalize();
      const multiplier = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1;
      this.position.addScaledVector(this.move, this.speed * multiplier * safeDt);
    }
    this.camera.position.copy(this.position);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('mousemove', this._onMouseMove);
    this.element.removeEventListener('click', this._onClick);
  }
}

