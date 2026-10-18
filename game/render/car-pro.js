import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CarModel as LegacyCarModel } from '../engine/render/car.js';
import { clamp } from '../engine/sim/math.js';
import { numberTexture, radialTexture } from './textures.js';
import bodyUrl from './assets/gt-body.glb?url';
import { buildLmdhBody } from './lmdh-body.js';

// Presentation car: a Blender GT body merged into one draw per material, a
// per-car clear-coated livery, a seated driver, light glows and exhaust pops.
// GT3 entries get one of the modelled cars in assets/gt3 (built by
// scripts/blender/gt3), picked per team; the safety car keeps gt-body.glb.
// It keeps the host CarModel API that main.js relies on.

const gt3Urls = import.meta.glob('./assets/gt3/*.glb', { query: '?url', import: 'default', eager: true });
const gt3Meta = import.meta.glob('./assets/gt3/*.json', { import: 'default', eager: true });
const gt3Id = (path) => path.match(/([^/]+)\.\w+$/)[1];
const GT3 = Object.fromEntries(Object.entries(gt3Urls).map(([path, url]) => [gt3Id(path), { url, meta: gt3Meta[path.replace(/\.glb$/, '.json')] ?? {} }]));
export const GT3_MODELS = Object.keys(GT3);
// Each team runs the car whose real-world livery its colours echo.
const TEAM_MODEL = {
  lumen: 'corvette', verdant: 'corvette', ember: 'mclaren', harbor: 'mclaren', crimson: 'ferrari', saffron: 'ferrari',
  glacier: 'porsche', rosso: 'porsche', meridian: 'aston', pinecrest: 'aston', onyx: 'mercedes', tidewater: 'mercedes',
  kestrel: 'mustang', aurum: 'lexus', solenne: 'bmw', nocturne: 'bmw'
};
// Livery pattern per model (paint shader branch).
const PATTERN = { mercedes: 1, mclaren: 2, ferrari: 3, porsche: 4, mustang: 5, aston: 6, bmw: 7, corvette: 8, lexus: 9 };

export function gt3ModelFor(team) {
  const want = TEAM_MODEL[team?.id];
  if (want && GT3[want]) return want;
  if (!GT3_MODELS.length) return null;
  let h = 0; for (const ch of String(team?.id ?? '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GT3_MODELS[h % GT3_MODELS.length];
}

const bodies = new Map();
function loadBody(url = bodyUrl) {
  if (bodies.has(url)) return bodies.get(url);
  const promise = new Promise((resolve) => {
    new GLTFLoader().load(url, (gltf) => {
      const groups = new Map();
      let shadowGeo = null;
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const name = o.name.startsWith('TowHook') ? 'Hook' : o.material.name;
        const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
        for (const key of Object.keys(g.attributes)) if (key !== 'position' && key !== 'normal') g.deleteAttribute(key);
        const flat = g.index ? g.toNonIndexed() : g;
        if (name === 'Shadow') { shadowGeo = flat; shadowGeo.deleteAttribute('normal'); return; }
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(flat);
      });
      const merged = new Map();
      for (const [name, list] of groups) merged.set(name, mergeGeometries(list, false));
      // Position-only copy of the whole body for the shadow proxy (when the file has no low-poly one).
      shadowGeo ??= mergeGeometries([...merged.values()].map((g) => { const c = new THREE.BufferGeometry(); c.setAttribute('position', g.attributes.position); return c; }), false);
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
      resolve({ merged, lamps, shadowGeo });
    }, undefined, () => resolve(null));
  });
  bodies.set(url, promise);
  return promise;
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
  shared.lens = new THREE.MeshStandardMaterial({ color: '#8d949b', metalness: 1, roughness: .1, envMapIntensity: 1.5 });
  shared.trim = new THREE.MeshPhysicalMaterial({ color: '#0b0c0d', roughness: .18, metalness: .2, clearcoat: 1, clearcoatRoughness: .05 });
  shared.amber = new THREE.MeshStandardMaterial({ color: '#ffb347', emissive: '#ff8a10', emissiveIntensity: 1.6, roughness: .2 });
  shared.id = new THREE.MeshStandardMaterial({ color: '#7dffa0', emissive: '#22ff66', emissiveIntensity: 2.2, roughness: .3 });
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

// Livery: per-model graphics in body space (pattern 1-9, see PATTERN) in the team
// colour and accent, or the legacy two-tone with twin stripes (pattern 0), plus
// number roundels on the doors and roof.
function paintMaterial(color, number, pattern = 0, meta = {}) {
  const m = new THREE.MeshPhysicalMaterial({ color, metalness: .55, roughness: .3, clearcoat: 1, clearcoatRoughness: .035, envMapIntensity: 1.25 });
  m.userData.uniforms = {
    uStripe: { value: new THREE.Color('#f3f1ea') }, uAccent: { value: new THREE.Color('#111416') },
    uNumber: { value: numberTexture(number) }, uPattern: { value: pattern },
    uDoor: { value: new THREE.Vector2(...(meta.door ?? [-0.18, 0.62])) }, uRoof: { value: new THREE.Vector2(...(meta.roof ?? [-0.42, 1.12])) }
  };
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, m.userData.uniforms);
    s.vertexShader = 'varying vec3 vObj;\n' + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj=position;');
    s.fragmentShader = 'varying vec3 vObj;uniform vec3 uStripe;uniform vec3 uAccent;uniform sampler2D uNumber;uniform int uPattern;uniform vec2 uDoor;uniform vec2 uRoof;\n' + s.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        float ax=abs(vObj.x), y=vObj.y, z=vObj.z;
        vec3 P=diffuseColor.rgb, A=uAccent, K=vec3(.025,.027,.03), Wt=vec3(.9,.9,.88), col=P;
        if(uPattern==0){
          float stripe=(1.-smoothstep(.055,.062,abs(ax-.15)))*smoothstep(.66,.70,y);
          float lower=1.-smoothstep(.40,.415,y+z*.035);
          col=mix(col,uStripe,stripe);
          col=mix(col,A,lower*step(.6,ax));
        } else if(uPattern==1){ // claws: jagged accent bands sweeping up the flanks and bonnet
          float zig=abs(fract(z*2.2)-.5);
          float band=y-(.30+(1.6-z)*.10)-zig*.16;
          float c=step(abs(band-.10),.035)+step(abs(band-.26),.02);
          c+=step(.74,y)*step(1.0,z)*step(abs(ax-.30-zig*.10),.028);
          col=mix(P,A,clamp(c,0.,1.));
        } else if(uPattern==2){ // primary nose and roof, dark tail and sills, accent seam
          float d=y*1.1+z*.30-.80;
          col=d<0.?K:P; col=mix(col,A,step(abs(d),.028));
        } else if(uPattern==3){ // accent saddle over the cockpit, dark pinstripes
          float band=abs(z-.45+y*.25);
          col=mix(P,A,step(band,.30)); col=mix(col,K,step(abs(band-.32),.018));
        } else if(uPattern==4){ // dark lower flanks and an accent slash behind the front wheel
          col=mix(P,K,step(y,.40+z*.03)*step(.7,ax));
          float slash=abs(z-.75+(y-.4)*1.2);
          col=mix(col,A,step(slash,.07)*step(.6,ax)*step(y,.9));
        } else if(uPattern==5){ // accent lower body sweeping up over the front wheels
          float edge=.38+.22*smoothstep(1.,2.2,z)+.04*sin(z*2.);
          col=mix(P,A,step(y,edge)); col=mix(col,K,step(abs(y-edge),.012));
        } else if(uPattern==6){ // twin accent swooshes along the flanks, bonnet arrow
          float s1=abs(y-(.55+.10*sin(z*1.3+.6)));
          col=mix(P,A,clamp(step(s1,.022)+step(abs(s1-.07),.012),0.,1.)*step(.75,ax));
          col=mix(col,A,step(.76,y)*step(1.2,z)*step(ax,min(.30,.06+(2.4-z)*.14)));
        } else if(uPattern==7){ // art-car colour blocks
          vec2 q=vec2(z*.9+y*.6,z*.5-y*1.3+ax*.4);
          float c=mod(floor(q.x*1.6)+floor(q.y*1.4),4.);
          col=c<1.?P:c<2.?A:c<3.?Wt:mix(P,K,.6);
        } else if(uPattern==8){ // dark roof, accent shoulder pinstripe
          col=mix(P,K,step(1.0,y)*step(ax,.6));
          col=mix(col,A,step(abs(y-.72+z*.015),.012)*step(.8,ax));
        } else if(uPattern==9){ // accent lower body and a rising side blade
          col=mix(P,A,step(y,.33));
          float blade=abs(y-(.40+(1.-z)*.10));
          col=mix(col,A,step(blade,.03)*step(z,1.)*step(-2.,z)*step(.8,ax));
        }
        diffuseColor.rgb=col;
        // Door roundel, readable from both sides.
        vec2 du=vec2(-sign(vObj.x)*(z-uDoor.x),y-uDoor.y)/.52+.5;
        if(ax>.78&&du.x>0.&&du.x<1.&&du.y>0.&&du.y<1.){vec4 n=texture2D(uNumber,du);diffuseColor.rgb=mix(diffuseColor.rgb,n.rgb,n.a);}
        vec2 ru=vec2(-vObj.x,z-uRoof.x)/.5+.5;
        if(y>uRoof.y&&ru.x>0.&&ru.x<1.&&ru.y>0.&&ru.y<1.){vec4 n=texture2D(uNumber,ru);diffuseColor.rgb=mix(diffuseColor.rgb,n.rgb,n.a);}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float flake=fract(sin(dot(floor(vObj*900.),vec3(12.9898,78.233,37.719)))*43758.5453);
        roughnessFactor=clamp(roughnessFactor*(.75+flake*.5),.05,1.);`);
  };
  m.customProgramCacheKey = () => 'phantom-paint-v2';
  return m;
}

function mesh(geo, mat, parent, x = 0, y = 0, z = 0, cast = true) {
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true; parent.add(m); return m;
}

let serial = 0;
// Headlight level for every car, 0 (daylight) to 1 (dark): brighter lamps and wider glows.
let lamps = 0;
export function setHeadlights(k) {
  if (k === lamps || !shared.lightF) return;
  lamps = k; shared.lightF.emissiveIntensity = 5 + k * 10; shared.glow.opacity = .55 + k * .4;
}

export class CarModel {
  constructor(car, team = null) {
    const S = sharedMaterials();
    this.car = car; this.root = new THREE.Group(); this.body = new THREE.Group(); this.root.add(this.body);
    this.number = car.id === 0 ? 7 : 11 + ((car.id * 7 + serial++) % 88);
    const proto = car.classId === 'lmdh', R = car.spec?.radius ?? .345;
    // GT cars with a team get that team's modelled GT3; the safety car keeps the generic body.
    this.modelId = !proto && team ? gt3ModelFor(team) : null;
    const meta = this.modelId ? GT3[this.modelId].meta : {};
    this.paint = paintMaterial(car.color || '#c43b25', this.number, PATTERN[this.modelId] ?? 0, meta);
    if (team?.accent) this.paint.userData.uniforms.uAccent.value.set(team.accent);
    this.tail = new THREE.MeshStandardMaterial({ color: '#5a0804', emissive: '#ff1a06', emissiveIntensity: 1.2, roughness: .2 });
    this.brakeMaterials = [this.tail];
    this.radius = R;
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(proto ? 2.3 : 2.35, proto ? 5.4 : 5.0), S.contact); shadow.rotation.x = -Math.PI / 2; shadow.position.y = .012; shadow.renderOrder = 1; this.root.add(shadow);

    // Interior and driver sit inside the glasshouse.
    this.interior = new THREE.Group(); this.body.add(this.interior);
    // A prototype driver lies lower and nearer the centreline under the canopy.
    if (proto) this.interior.position.set(.07, -.2, -.12);
    else if (meta.seatZ != null) this.interior.position.z = meta.seatZ + .22;
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
      const group = new THREE.Group(); group.position.set(w.x, R, w.z); this.root.add(group);
      const spin = new THREE.Group(); group.add(spin);
      const tire = mesh(new THREE.CylinderGeometry(R - .007, R - .007, proto ? .31 : .29, 36, 1), S.rubber, spin); tire.rotation.z = Math.PI / 2;
      const rim = mesh(new THREE.CylinderGeometry(.24, .24, .3, 24, 1), S.alloy, spin); rim.rotation.z = Math.PI / 2;
      const caliper = mesh(new THREE.BoxGeometry(.05, .16, .09), new THREE.MeshStandardMaterial({ color: '#d4a020', metalness: .5, roughness: .35 }), group, Math.sign(w.x) * .13, .07, -.14);
      caliper.rotation.x = .5;
      this.wheels.push({ group, spin, discMaterial, placeholder: [tire, rim] });
    });

    this.ready = (proto ? Promise.resolve(buildLmdhBody()) : loadBody(this.modelId ? GT3[this.modelId].url : bodyUrl)).then((body) => {
      if (!body) { this.useLegacyBody(); return; }
      this.addShadowProxy(body.shadowGeo, car);
      const mats = { Paint: this.paint, Glass: S.glass, Carbon: S.carbon, Grille: S.grille, Chrome: S.chrome, Well: S.well, Hook: S.hook, LightF: S.lightF, LightR: this.tail, Lens: S.lens, Trim: S.trim, Amber: S.amber, Id: S.id };
      for (const [name, geo] of body.merged) {
        const m = mesh(geo, mats[name] || S.carbon, this.body, 0, 0, 0, name !== 'Glass' && name !== 'LightF' && name !== 'LightR');
        if (name === 'Glass') m.renderOrder = 3;
      }
      for (const p of body.lamps.LightF || []) { const g = new THREE.Sprite(S.glow); g.position.copy(p).add(new THREE.Vector3(0, 0, .06)); g.scale.setScalar(.55); this.body.add(g); this.glowsF.push(g); }
      const rearGlow = S.glow.clone(); rearGlow.color.set('#ff2a10'); this.rearGlow = rearGlow;
      for (const p of body.lamps.LightR || []) { const g = new THREE.Sprite(rearGlow); g.position.copy(p).add(new THREE.Vector3(0, 0, -.05)); g.scale.setScalar(.5); this.body.add(g); this.glowsR.push(g); }
      for (const [i, side] of [-1, 1].entries()) {
        const f = new THREE.Mesh(new THREE.PlaneGeometry(.55, .22), S.flame.clone()); f.position.set(side * 1.25, .28, -.72); f.rotation.x = -Math.PI / 2;
        // Prototype exhausts exit the tail: flames point straight back.
        if (body.exhaust) { f.position.copy(body.exhaust[i]).add(new THREE.Vector3(0, 0, -.2)); f.rotation.set(-Math.PI / 2, 0, Math.PI / 2); f.scale.set(.8, .8, 1); }
        // Modelled GT3s: side pipes fire outward, rear pipes straight back.
        else if (meta.exhaust) {
          const [x, y, z] = meta.exhaust[i % meta.exhaust.length];
          if (meta.exhaustDir === 'rear') { f.position.set(meta.exhaust.length > 1 ? x : side * Math.abs(x), y, z - .2); f.rotation.set(-Math.PI / 2, 0, Math.PI / 2); f.scale.set(.8, .8, 1); }
          else f.position.set(side * (Math.abs(x) + .22), y, z);
        }
        const f2 = f.clone(); f2.rotation.set(0, 0, 0); f2.position.copy(f.position); f2.material = f.material;
        f.visible = f2.visible = false; this.body.add(f, f2); this.flames.push(f, f2);
      }
    });

    // Presentation state.
    this.pop = 0; this.prevThrottle = 0; this.prevGear = car.gear; this.flicker = 0;
  }

  // One merged shadow caster per car (body plus wheels) on layer 1, which only
  // the sun's shadow camera sees: ~45 shadow draws per car become one, and the
  // visible parts stop casting.
  addShadowProxy(bodyGeo, car) {
    shared.wheelShadow ??= new THREE.CylinderGeometry(.338, .338, .29, 12, 1).rotateZ(Math.PI / 2).deleteAttribute('normal').deleteAttribute('uv');
    const wheels = car.wheels.map((w) => shared.wheelShadow.clone().translate(w.x, .345, w.z));
    const geo = mergeGeometries([bodyGeo, ...wheels.map((g) => (g.index ? g.toNonIndexed() : g))], false);
    shared.shadowOnly ??= new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    const proxy = new THREE.Mesh(geo, shared.shadowOnly); proxy.castShadow = true; proxy.layers.set(1);
    this.root.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    this.body.add(proxy); this.shadowProxy = proxy;
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
    this.tail.emissiveIntensity = braking ? 7 : 1.3 + lamps * 2.2;
    if (this.rearGlow) this.rearGlow.opacity = braking ? .85 : .22 + lamps * .3;
    if (this.lampScale !== lamps) { this.lampScale = lamps; for (const g of this.glowsF) g.scale.setScalar(.55 * (1 + lamps * 1.6)); }
    this.wheels.forEach((v, i) => {
      const w = car.wheels[i];
      v.group.rotation.y = w.steer; v.group.position.y = this.radius + .005 - (w.compression - .045);
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
      const detail = template.clone(true); detail.scale.multiplyScalar(this.radius / .345);
      detail.traverse((o) => {
        if (!o.isMesh) return; o.castShadow = !this.shadowProxy; o.receiveShadow = true;
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
