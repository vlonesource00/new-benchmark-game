import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CarModel as LegacyCarModel } from '../engine/render/car.js';
import { clamp } from '../engine/sim/math.js';
import { numberTexture, radialTexture } from './textures.js';
import bodyUrl from './assets/gt-body.glb?url';

// Presentation car: the Blender GT body (gt-body.glb) merged into one draw per
// material, a per-car clear-coated livery, a seated driver, light glows and
// exhaust pops. It keeps the host CarModel API that main.js relies on.

let bodyPromise = null;
function loadBody() {
  bodyPromise ??= new Promise((resolve) => {
    new GLTFLoader().load(bodyUrl, (gltf) => {
      const groups = new Map();
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const name = o.name.startsWith('TowHook') ? 'Hook' : o.material.name;
        const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
        for (const key of Object.keys(g.attributes)) if (key !== 'position' && key !== 'normal') g.deleteAttribute(key);
        const flat = g.index ? g.toNonIndexed() : g;
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(flat);
      });
      const merged = new Map();
      for (const [name, list] of groups) merged.set(name, mergeGeometries(list, false));
      // Lamp centroids per side drive the glow sprites.
      const lamps = {};
      for (const key of ['LightF', 'LightR']) {
        const pos = merged.get(key)?.attributes.position; if (!pos) continue;
        const acc = { l: new THREE.Vector3(), r: new THREE.Vector3(), nl: 0, nr: 0 };
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          if (Math.abs(x) < .3) continue; // tow hook / rain light sit on the centreline
          if (x < 0) { acc.l.x += x; acc.l.y += y; acc.l.z += z; acc.nl++; } else { acc.r.x += x; acc.r.y += y; acc.r.z += z; acc.nr++; }
        }
        lamps[key] = [acc.l.divideScalar(Math.max(1, acc.nl)), acc.r.divideScalar(Math.max(1, acc.nr))];
      }
      resolve({ merged, lamps });
    }, undefined, () => resolve(null));
  });
  return bodyPromise;
}

const shared = {};
function sharedMaterials() {
  if (shared.glass) return shared;
  shared.glass = new THREE.MeshPhysicalMaterial({ color: '#0d1a20', metalness: .1, roughness: .04, clearcoat: 1, clearcoatRoughness: .02, transparent: true, opacity: .62, envMapIntensity: 1.6 });
  shared.carbon = new THREE.MeshPhysicalMaterial({ color: '#111416', roughness: .38, metalness: .25, clearcoat: .7, clearcoatRoughness: .12 });
  carbonWeave(shared.carbon);
  shared.grille = new THREE.MeshStandardMaterial({ color: '#0b0d0e', roughness: .7, metalness: .4 });
  shared.chrome = new THREE.MeshStandardMaterial({ color: '#dfe4e6', roughness: .08, metalness: 1, envMapIntensity: 1.4 });
  shared.well = new THREE.MeshStandardMaterial({ color: '#070808', roughness: .95 });
  shared.hook = new THREE.MeshStandardMaterial({ color: '#c8281c', roughness: .45, metalness: .3 });
  shared.lightF = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#e4f2ff', emissiveIntensity: 5, roughness: .1 });
  shared.rubber = new THREE.MeshStandardMaterial({ color: '#141516', roughness: .92 });
  shared.alloy = new THREE.MeshStandardMaterial({ color: '#8f969a', metalness: 1, roughness: .24 });
  shared.suit = new THREE.MeshStandardMaterial({ color: '#1c2226', roughness: .85 });
  shared.visor = new THREE.MeshPhysicalMaterial({ color: '#0a0c10', roughness: .05, metalness: .6, clearcoat: 1, iridescence: .8, iridescenceIOR: 1.6 });
  shared.screen = new THREE.MeshBasicMaterial({ color: '#7fd6cf' });
  shared.glow = new THREE.SpriteMaterial({ map: radialTexture([[0, 'rgba(255,255,255,1)'], [.18, 'rgba(255,245,230,.55)'], [1, 'rgba(255,240,220,0)']]), color: '#fff5e8', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: .55 });
  shared.flame = new THREE.MeshBasicMaterial({ map: radialTexture([[0, 'rgba(255,255,240,1)'], [.3, 'rgba(255,170,60,.9)'], [.7, 'rgba(255,70,10,.35)'], [1, 'rgba(120,20,0,0)']]), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide, toneMapped: false });
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = ((x / (size - 1) - .5) * 2) ** 4 + ((y / (size - 1) - .5) * 2) ** 4, i = (y * size + x) * 4;
    data[i + 3] = Math.round(Math.max(0, 1 - r) ** 1.5 * 190);
  }
  const map = new THREE.DataTexture(data, size, size); map.needsUpdate = true; map.magFilter = map.minFilter = THREE.LinearFilter;
  shared.contact = new THREE.MeshBasicMaterial({ color: '#000000', alphaMap: map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  shared.contact.alphaMap = null; shared.contact.map = map; // DataTexture carries alpha in .a
  return shared;
}

// Object-space twill weave for untextured carbon parts.
function carbonWeave(material) {
  material.onBeforeCompile = (s) => {
    s.vertexShader = 'varying vec3 vObj;\n' + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj=position;');
    s.fragmentShader = 'varying vec3 vObj;\n' + s.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      vec3 q=vObj*95.;float wv=step(.5,fract((floor(q.x+q.z)+floor(q.y))*.5));
      diffuseColor.rgb*=mix(.72,1.25,wv*(.5+.5*sin(q.x*3.1416)*sin(q.z*3.1416)));`);
  };
}

// Livery: two-tone lower body, twin stripes and number roundels projected in body space.
function paintMaterial(color, number) {
  const m = new THREE.MeshPhysicalMaterial({ color, metalness: .55, roughness: .3, clearcoat: 1, clearcoatRoughness: .035, envMapIntensity: 1.25 });
  m.userData.uniforms = {
    uStripe: { value: new THREE.Color('#f3f1ea') }, uAccent: { value: new THREE.Color('#111416') },
    uNumber: { value: numberTexture(number) }
  };
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, m.userData.uniforms);
    s.vertexShader = 'varying vec3 vObj;\n' + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj=position;');
    s.fragmentShader = 'varying vec3 vObj;uniform vec3 uStripe;uniform vec3 uAccent;uniform sampler2D uNumber;\n' + s.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        float ax=abs(vObj.x);
        float stripe=(1.-smoothstep(.055,.062,abs(ax-.15)))*smoothstep(.66,.70,vObj.y);
        float lower=1.-smoothstep(.40,.415,vObj.y+vObj.z*.035);
        diffuseColor.rgb=mix(diffuseColor.rgb,uStripe,stripe);
        diffuseColor.rgb=mix(diffuseColor.rgb,uAccent,lower*step(.6,ax));
        // Door roundel, readable from both sides.
        vec2 du=vec2(-sign(vObj.x)*(vObj.z+.18),vObj.y-.62)/.52+.5;
        if(ax>.78&&du.x>0.&&du.x<1.&&du.y>0.&&du.y<1.){vec4 n=texture2D(uNumber,du);diffuseColor.rgb=mix(diffuseColor.rgb,n.rgb,n.a);}
        vec2 ru=vec2(-vObj.x,vObj.z+.42)/.5+.5;
        if(vObj.y>1.12&&ru.x>0.&&ru.x<1.&&ru.y>0.&&ru.y<1.){vec4 n=texture2D(uNumber,ru);diffuseColor.rgb=mix(diffuseColor.rgb,n.rgb,n.a);}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float flake=fract(sin(dot(floor(vObj*900.),vec3(12.9898,78.233,37.719)))*43758.5453);
        roughnessFactor=clamp(roughnessFactor*(.75+flake*.5),.05,1.);`);
  };
  m.customProgramCacheKey = () => 'phantom-paint';
  return m;
}

function mesh(geo, mat, parent, x = 0, y = 0, z = 0, cast = true) {
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true; parent.add(m); return m;
}

let serial = 0;
export class CarModel {
  constructor(car) {
    const S = sharedMaterials();
    this.car = car; this.root = new THREE.Group(); this.body = new THREE.Group(); this.root.add(this.body);
    this.number = car.id === 0 ? 7 : 11 + ((car.id * 7 + serial++) % 88);
    this.paint = paintMaterial(car.color || '#c43b25', this.number);
    this.tail = new THREE.MeshStandardMaterial({ color: '#5a0804', emissive: '#ff1a06', emissiveIntensity: 1.2, roughness: .2 });
    this.brakeMaterials = [this.tail];
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.35, 5.0), S.contact); shadow.rotation.x = -Math.PI / 2; shadow.position.y = .012; shadow.renderOrder = 1; this.root.add(shadow);

    // Interior and driver sit inside the glasshouse.
    this.interior = new THREE.Group(); this.body.add(this.interior);
    mesh(new THREE.BoxGeometry(1.3, .15, .25), S.carbon, this.interior, 0, .8, .5);
    mesh(new THREE.BoxGeometry(.46, .22, .55), S.carbon, this.interior, -.32, .55, -.22);
    mesh(new THREE.BoxGeometry(.48, .66, .12), S.carbon, this.interior, -.32, .86, -.5).rotation.x = -.16;
    mesh(new THREE.BoxGeometry(.25, .12, .01), S.screen, this.interior, -.31, .87, .37, false);
    this.steeringWheel = mesh(new THREE.TorusGeometry(.15, .022, 8, 24), S.carbon, this.interior, -.32, .86, .17);
    mesh(new THREE.BoxGeometry(.28, .05, .03), S.alloy, this.steeringWheel);
    for (const side of [-1, 1]) mesh(new THREE.CylinderGeometry(.02, .02, .75, 8), S.alloy, this.interior, side * .6, 1.0, -.7).rotation.x = -.08;
    const torso = mesh(new THREE.CapsuleGeometry(.19, .32, 4, 10), S.suit, this.interior, -.32, .78, -.34); torso.rotation.x = -.35;
    this.helmet = mesh(new THREE.SphereGeometry(.145, 20, 14), this.paint, this.interior, -.32, 1.06, -.22);
    const visor = mesh(new THREE.SphereGeometry(.148, 20, 8, -1.1, 2.2, 1.15, .55), S.visor, this.helmet, 0, 0, 0, false); visor.rotation.y = 0;
    for (const side of [-1, 1]) { const arm = mesh(new THREE.CapsuleGeometry(.05, .34, 4, 8), S.suit, this.interior, -.32 + side * .16, .86, -.05); arm.rotation.x = 1.25; }

    // Headlight and tail glows are billboards so they read at any distance.
    this.glowsF = []; this.glowsR = [];
    this.flames = [];

    this.wheels = [];
    car.wheels.forEach((w) => {
      const discMaterial = new THREE.MeshStandardMaterial({ color: '#3a3b3c', metalness: .8, roughness: .45, emissive: '#ff4a12', emissiveIntensity: 0 });
      const group = new THREE.Group(); group.position.set(w.x, .345, w.z); this.root.add(group);
      const spin = new THREE.Group(); group.add(spin);
      const tire = mesh(new THREE.CylinderGeometry(.338, .338, .29, 36, 1), S.rubber, spin); tire.rotation.z = Math.PI / 2;
      const rim = mesh(new THREE.CylinderGeometry(.24, .24, .3, 24, 1), S.alloy, spin); rim.rotation.z = Math.PI / 2;
      const caliper = mesh(new THREE.BoxGeometry(.05, .16, .09), new THREE.MeshStandardMaterial({ color: '#d4a020', metalness: .5, roughness: .35 }), group, Math.sign(w.x) * .13, .07, -.14);
      caliper.rotation.x = .5;
      this.wheels.push({ group, spin, discMaterial, placeholder: [tire, rim] });
    });

    this.ready = loadBody().then((body) => {
      if (!body) { this.useLegacyBody(); return; }
      const mats = { Paint: this.paint, Glass: S.glass, Carbon: S.carbon, Grille: S.grille, Chrome: S.chrome, Well: S.well, Hook: S.hook, LightF: S.lightF, LightR: this.tail };
      for (const [name, geo] of body.merged) {
        const m = mesh(geo, mats[name] || S.carbon, this.body, 0, 0, 0, name !== 'Glass' && name !== 'LightF' && name !== 'LightR');
        if (name === 'Glass') m.renderOrder = 3;
      }
      for (const p of body.lamps.LightF || []) { const g = new THREE.Sprite(S.glow); g.position.copy(p).add(new THREE.Vector3(0, 0, .06)); g.scale.setScalar(.55); this.body.add(g); this.glowsF.push(g); }
      const rearGlow = S.glow.clone(); rearGlow.color.set('#ff2a10'); this.rearGlow = rearGlow;
      for (const p of body.lamps.LightR || []) { const g = new THREE.Sprite(rearGlow); g.position.copy(p).add(new THREE.Vector3(0, 0, -.05)); g.scale.setScalar(.5); this.body.add(g); this.glowsR.push(g); }
      for (const side of [-1, 1]) {
        const f = new THREE.Mesh(new THREE.PlaneGeometry(.55, .22), S.flame.clone()); f.position.set(side * 1.25, .28, -.72); f.rotation.x = -Math.PI / 2;
        const f2 = f.clone(); f2.rotation.set(0, 0, 0); f2.position.copy(f.position); f2.material = f.material;
        f.visible = f2.visible = false; this.body.add(f, f2); this.flames.push(f, f2);
      }
    });

    // Presentation state.
    this.pop = 0; this.prevThrottle = 0; this.prevGear = car.gear; this.flicker = 0;
  }

  useLegacyBody() {
    const legacy = new LegacyCarModel(this.car);
    legacy.paint.color.copy(this.paint.color);
    for (const child of [...legacy.body.children]) this.body.add(child);
  }

  update(dt) {
    const car = this.car;
    this.root.position.set(car.x, .025, car.z); this.root.rotation.y = car.yaw;
    this.body.position.y = -car.heave; this.body.rotation.set(car.pitch, 0, car.roll);
    this.steeringWheel.rotation.z = -car.steering * 9;
    const braking = car.controls.brake > .05;
    this.tail.emissiveIntensity = braking ? 7 : 1.3;
    if (this.rearGlow) this.rearGlow.opacity = braking ? .85 : .22;
    this.wheels.forEach((v, i) => {
      const w = car.wheels[i];
      v.group.rotation.y = w.steer; v.group.position.y = .35 - (w.compression - .045);
      v.spin.rotation.x += w.omega * dt;
      v.discMaterial.emissiveIntensity = clamp((w.brakeTemp - 450) / 200, 0, 2.2);
    });
    // Exhaust flames: fired by render/exhaust.js so they land with the sound.
    if (dt > 0) { this.pop = Math.max(0, this.pop - dt); this.flicker += dt * 60; }
    const on = this.pop > 0, grow = this.popSize ?? 1;
    for (let i = 0; i < this.flames.length; i++) {
      const f = this.flames[i]; f.visible = on;
      if (on) { const k = .6 + .4 * Math.sin(this.flicker * (1.7 + i * .3)); f.scale.set((.6 + k * .7) * grow, (.8 + k * .4) * (.7 + grow * .3), 1); f.material.opacity = Math.min(1, this.pop * 9); }
    }
  }

  /** Exhaust pop: strength 0..1 (crackle ~.3, lift-off bang ~1). */
  fire(strength) {
    this.pop = Math.max(this.pop, .05 + strength * .15);
    this.popSize = .7 + strength * 1.3;
  }

  cockpit(active) { this.body.visible = !active; }

  setWheelAsset(template) {
    for (const wheel of this.wheels) {
      for (const p of wheel.placeholder) p.visible = false;
      const detail = template.clone(true);
      detail.traverse((o) => {
        if (!o.isMesh) return; o.castShadow = true; o.receiveShadow = true;
        if (o.material?.isMeshStandardMaterial) { o.material = o.material.clone(); o.material.envMapIntensity = 1.3; }
      });
      wheel.spin.add(detail);
      const disc = mesh(new THREE.CylinderGeometry(.195, .195, .02, 32), wheel.discMaterial, wheel.spin); disc.rotation.z = Math.PI / 2;
    }
  }

  setColor(color) {
    this.paint.color.set(color); this.car.color = color;
    const lum = this.paint.color.r * .3 + this.paint.color.g * .59 + this.paint.color.b * .11;
    this.paint.userData.uniforms.uStripe.value.set(lum > .45 ? '#121416' : '#f3f1ea');
    this.paint.userData.uniforms.uNumber.value = numberTexture(this.number, '#' + this.paint.color.getHexString());
  }
}
