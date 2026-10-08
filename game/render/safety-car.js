import * as THREE from 'three';
import { CarModel } from './car-pro.js';
import { numberTexture, radialTexture } from './textures.js';

// The safety car: the GT body in a silver race-control livery with amber
// stripes and "SC" roundels, a roof light bar whose amber lamps strobe in
// alternation while it leads the field (lights out on its in-lap), and
// SAFETY CAR boards on the front and back of the bar.

const AMBER = '#ffae1a';
let boardTex = null;
function boardTexture() {
  if (boardTex) return boardTex;
  const c = document.createElement('canvas'); c.width = 512; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#121416'; x.fillRect(0, 0, 512, 64);
  x.fillStyle = AMBER; x.fillRect(0, 0, 512, 5); x.fillRect(0, 59, 512, 5);
  x.fillStyle = '#f4f2ea'; x.font = 'italic 900 44px "Arial Black", Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('SAFETY CAR', 256, 34);
  boardTex = new THREE.CanvasTexture(c); boardTex.colorSpace = THREE.SRGBColorSpace; boardTex.anisotropy = 8;
  return boardTex;
}

export class SafetyCarModel extends CarModel {
  constructor(car) {
    super(car);
    this.number = 'SC';
    this.paint.color.set('#d9dde1');
    this.paint.userData.uniforms.uStripe.value.set(AMBER);
    this.paint.userData.uniforms.uAccent.value.set('#16191c');
    this.paint.userData.uniforms.uNumber.value = numberTexture('SC', AMBER);

    // Roof light bar: carbon base, four amber lenses, two boards.
    const bar = new THREE.Group(); bar.position.set(0, 1.235, -0.18); this.body.add(bar);
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.08, .07, .26), new THREE.MeshStandardMaterial({ color: '#15171a', roughness: .5, metalness: .3 }));
    bar.add(base);
    this.lamps = [];
    const glowMap = radialTexture([[0, 'rgba(255,255,255,1)'], [.2, 'rgba(255,190,80,.6)'], [1, 'rgba(255,150,20,0)']]);
    for (const [i, x] of [-.42, -.16, .16, .42].entries()) {
      const mat = new THREE.MeshStandardMaterial({ color: '#7a4a08', emissive: AMBER, emissiveIntensity: 0, roughness: .15, transparent: true, opacity: .92 });
      const lens = new THREE.Mesh(new THREE.BoxGeometry(.22, .085, .22), mat); lens.position.set(x, .07, 0); bar.add(lens);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: AMBER, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
      glow.position.set(x, .08, 0); glow.scale.setScalar(1.1); bar.add(glow);
      this.lamps.push({ mat, glow, group: i < 2 ? 0 : 1 });
    }
    const boardMat = new THREE.MeshBasicMaterial({ map: boardTexture(), toneMapped: false });
    for (const [z, ry] of [[.135, 0], [-.135, Math.PI]]) {
      const board = new THREE.Mesh(new THREE.PlaneGeometry(1.0, .125), boardMat); board.position.set(0, .0, z); board.rotation.y = ry; bar.add(board);
    }
    this.flash = 0;
  }

  update(dt) {
    super.update(dt);
    // Twin-phase strobe: each side double-pulses, the sides alternating at ~1.6 Hz.
    this.flash += dt;
    const on = this.car.lights !== false, t = (this.flash * 1.6) % 1;
    for (const l of this.lamps) {
      const p = l.group ? (t + .5) % 1 : t;
      const lit = on && (p < .12 || (p > .2 && p < .32));
      l.mat.emissiveIntensity = lit ? 9 : on ? .25 : 0;
      l.glow.material.opacity = lit ? .95 : 0;
    }
  }
}
