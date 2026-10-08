import * as THREE from 'three';
import { random } from '../sim/math.js';

// Rain around the camera: one bounded line buffer (no allocations during a frame). The streaks lean with the wind
// and lengthen with the rate; `amount` is the local rain (0 dry .. 1 = a 24 mm/h downpour, up to ~1.3 in a band).
export class WeatherEffects {
  constructor(scene, count = 2400) {
    this.count = count; this.drops = new Float32Array(count * 4); const rng = random(244);
    for (let i = 0; i < count; i++) { this.drops[i * 4] = (rng() - .5) * 70; this.drops[i * 4 + 1] = rng() * 36; this.drops[i * 4 + 2] = (rng() - .5) * 70; this.drops[i * 4 + 3] = .8 + rng() * .5; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3).setUsage(THREE.DynamicDrawUsage));
    this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#c6dce8', transparent: true, opacity: .2, depthWrite: false }));
    this.rain.frustumCulled = false; this.rain.visible = false; scene.add(this.rain);
    this.level = 0;
  }
  update(at, dt, amount, wind = null) {
    // Ease in and out so a passing front reads as a shower arriving, not a switch.
    this.level += ((amount || 0) - this.level) * Math.min(1, dt * 1.5);
    const a = THREE.MathUtils.clamp(this.level, 0, 1.3); this.rain.visible = a > .02; if (!this.rain.visible) return;
    this.rain.material.opacity = .08 + Math.min(1, a) * .2; const pos = this.rain.geometry.attributes.position;
    const count = Math.floor(this.count * Math.min(1, a)); this.rain.geometry.setDrawRange(0, count * 2);
    const fall = 26 + a * 8, len = .7 + a * .9, wx = (wind?.dx ?? 0) * (wind?.speed ?? 0) * .35, wz = (wind?.dz ?? 0) * (wind?.speed ?? 0) * .35;
    for (let i = 0; i < count; i++) {
      const k = i * 4, v = fall * this.drops[k + 3];
      this.drops[k + 1] = (this.drops[k + 1] - dt * v + 36) % 36;
      const x = at.x + this.drops[k], y = at.y - 8 + this.drops[k + 1], z = at.z + this.drops[k + 2], t = len / v;
      pos.setXYZ(i * 2, x, y, z); pos.setXYZ(i * 2 + 1, x - wx * t, y - len * this.drops[k + 3], z - wz * t);
    }
    pos.needsUpdate = true;
  }
}
