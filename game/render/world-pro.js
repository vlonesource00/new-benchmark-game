import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { random, clamp, wrap } from '../engine/sim/math.js';
import { PitLane } from '../core/pit.js';
import { LIGHTING, wetSurface } from '../engine/render/surfaces.js';
import { ribbon } from '../engine/render/world.js';
import {
  asphaltMaps, grassMaps, gravelMaps, concreteMaps, containerMaps, waterNormal, fenceTexture,
  facadeMaps, signTexture, sponsorTexture, SPONSORS, radialTexture, smokeTexture
} from './textures.js';

// A flat strip between two lateral edge functions over part of the lap.
// Normals are forced up and the material should be double sided, so the order
// of the two edges does not matter.
function band(track, from, length, a, b, y, step = 1.5) {
  const n = Math.max(2, Math.ceil(length / step)), pos = [], nrm = [], uv = [], idx = [];
  for (let i = 0; i <= n; i++) {
    const u = from + i / n * length, s = wrap(u, track.length);
    for (const l of [a(s), b(s)]) { const p = track.at(s, l); pos.push(p.x, y, p.z); nrm.push(0, 1, 0); uv.push(l / 4, u / 4); }
    if (i < n) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); return g;
}
const side3 = (lane) => lane.side;
const smooth01 = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

// Presentation world for the Harbor Ring. The circuit geometry comes straight
// from the host Track (same ribbon, kerb, rubber and grid placement); everything
// here is visual. Static scenery lives under `root` with frozen matrices, moving
// life under `live`.

const TIME = { value: 0 };
const std = (color, roughness = .8, metalness = 0, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
function add(parent, geo, material, x = 0, y = 0, z = 0, cast = true) {
  const m = new THREE.Mesh(geo, material); m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true; parent.add(m); return m;
}
// Flat paint and decals lying on the road: pull them towards the camera by depth slope,
// which is what keeps grazing-angle surfaces from fighting far down the straight.
const decal = (layer) => ({ polygonOffset: true, polygonOffsetFactor: -layer, polygonOffsetUnits: -2 * layer });
const box = (p, m, x, y, z, w, h, d, cast = true) => add(p, new THREE.BoxGeometry(w, h, d), m, x, y, z, cast);
function repeatMaps(maps, rx, ry = rx) {
  const out = {};
  for (const [k, v] of Object.entries(maps)) { const t = v.clone(); t.repeat.set(rx, ry); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; out[k] = t; }
  return out;
}
function canvasTexture(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

// Shared vertex hook: wind sway for foliage/flags, keyed by strength.
function sway(material, amount, key, mode = 'tree') {
  material.onBeforeCompile = (s) => {
    s.uniforms.uTime = TIME;
    s.vertexShader = 'uniform float uTime;\n' + s.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float ph = 0.;
      #ifdef USE_INSTANCING
      ph = instanceMatrix[3].x * .071 + instanceMatrix[3].z * .053;
      #endif
      ${mode === 'flag'
        ? 'float fx = max(position.x + .6, 0.); transformed.z += sin(fx * 3.2 - uTime * 7.5 + ph) * fx * ' + amount + '; transformed.y += sin(fx * 2.1 - uTime * 5.) * fx * .03;'
        : 'float hh = max(position.y, 0.); float g = sin(uTime * 1.4 + ph) * .6 + sin(uTime * 3.7 + ph * 2.3) * .25; transformed.x += g * hh * hh * ' + amount + '; transformed.z += cos(uTime * 1.1 + ph) * hh * hh * ' + amount + ' * .6;'}`);
  };
  material.customProgramCacheKey = () => 'sway-' + key;
  return material;
}

// Sweep an outward profile [[d, y], ...] along the track at lateral side*(offset+d).
// `from`/`length` limit it to part of the lap; `skip(s)` leaves gaps.
function sweep(track, profile, offset, side, steps = 1200, vScale = 4, { from = 0, length = track.length, skip = null } = {}) {
  const n = profile.length, pos = [], uv = [], idx = [];
  const len = [0]; for (let j = 1; j < n; j++) len.push(len[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]));
  for (let i = 0; i <= steps; i++) {
    const s = from + i / steps * length;
    for (let j = 0; j < n; j++) { const p = track.at(wrap(s, track.length), side * (offset + profile[j][0])); pos.push(p.x, profile[j][1], p.z); uv.push(len[j], s / vScale); }
  }
  for (let i = 0; i < steps; i++) for (let j = 0; j < n - 1; j++) {
    if (skip && skip(wrap(from + (i + .5) / steps * length, track.length))) continue;
    const a = i * n + j, b = a + 1, c = a + n, d = c + 1;
    if (side > 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals(); return g;
}

function foliageTexture(seed, palm = false) {
  return canvasTexture(512, 512, (c) => {
    const rng = random(seed);
    if (palm) {
      // One frond: a rib with drooping leaflets, drawn along +x.
      c.strokeStyle = '#5e5a2e'; c.lineWidth = 7; c.beginPath(); c.moveTo(10, 256); c.quadraticCurveTo(260, 230, 505, 270); c.stroke();
      for (let i = 0; i < 70; i++) {
        const t = i / 70, x = 14 + t * 485, y = 256 - Math.sin(t * Math.PI) * 18 + t * 14, l = (1 - t * .7) * 120;
        for (const dir of [-1, 1]) {
          c.strokeStyle = `hsl(${78 + rng() * 22},${34 + rng() * 18}%,${22 + rng() * 16}%)`; c.lineWidth = 5 - t * 3;
          c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + 12, y + dir * l * .5, x + 26, y + dir * l); c.stroke();
        }
      }
      return;
    }
    const crowns = [];
    c.strokeStyle = '#4a4130'; c.lineWidth = 16; c.lineCap = 'round'; c.beginPath(); c.moveTo(256, 510); c.lineTo(252, 300); c.stroke();
    for (let i = 0; i < 16; i++) { const a = rng() * Math.PI * 2, r = 40 + rng() * 120; crowns.push({ x: 256 + Math.cos(a) * r, y: 220 + Math.sin(a) * r * .8, r: 60 + rng() * 40 }); }
    crowns.sort((a, b) => a.y - b.y);
    for (const k of crowns) for (let j = 0; j < 520; j++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * k.r, x = k.x + Math.cos(a) * r, y = k.y + Math.sin(a) * r * .8;
      const light = 18 + rng() * 18 + (1 - (y - k.y + k.r) / (2 * k.r)) * 14;
      c.fillStyle = `hsl(${82 + rng() * 30},${28 + rng() * 22}%,${light}%)`; c.beginPath(); c.ellipse(x, y, 2 + rng() * 5, 1.5 + rng() * 2.5, rng() * 3, 0, Math.PI * 2); c.fill();
    }
  });
}

// Per-circuit dressing. Geometry-bound pieces (track, kerbs, pit, paddock,
// stands) are generic; the landscape around them comes from the theme.
export const THEMES = {
  'harbor-ring': { lighting: 'golden', hour: 17.7, harbor: true, city: 'metro', blimp: 'PORTO AZUL', banner: 'PORTO AZUL SHIPPING  ·  GRAND PRIX',
    hills: { colors: ['#5f6f5c', '#7d8a7f', '#98a39c'], height: 1, arc: [.45, 1.1] } },
  solenne: { lighting: 'day', hour: 13, city: 'village', palms: 0, trees: 2200, blimp: 'SOLENNE', banner: 'CIRCUIT DE SOLENNE  ·  GRAND PRIX',
    hills: { colors: ['#56704e', '#6f8a6a', '#93a69a'], height: 1.1 } },
  alpine: { lighting: 'night', hour: 21.5, ground: 'alpine', palms: 0, trees: 0, pines: 2600, stars: true, blimp: 'ALPENRING', banner: 'ALPENRING  ·  NACHTRENNEN',
    hills: { colors: ['#2a343c', '#3a4650', '#56626c'], height: 3.6, snow: true, jagged: true } },
  desert: { lighting: 'dusk', hour: 18.6, ground: 'sand', palms: 70, trees: 0, blades: false, rocks: true, blimp: 'MIRAGE', banner: 'MIRAGE 1000  ·  DESERT GRAND PRIX',
    hills: { colors: ['#a8603a', '#b97a52', '#caa07c'], height: 1.3, mesa: true } }
};

// Sun height (the y of the light direction) at each lighting preset; the day
// cycle blends neighbouring presets. Theme start hours sit on their preset.
const TWILIGHT = { sun: '#ff9a62', sky: '#6c6f8e', ground: '#4a4440', fog: '#6e6878', intensity: .9, fill: .6, environment: .4, exposure: 1.18, elevation: .06, turbidity: 5, density: .0006 };
const GREY = new THREE.Color();
const SKY_STOPS = [[-.12, 'night'], [0, 'twilight'], [.2, 'dusk'], [.42, 'golden'], [.95, 'day']].map(([y, mode]) => {
  const p = mode === 'twilight' ? TWILIGHT : LIGHTING[mode];
  return { y, p, mode, rayleigh: { night: .3, twilight: 2, dusk: 2.4 }[mode] ?? 1.6, cover: { golden: .5, day: .56, dusk: .6, twilight: .66, night: .72 }[mode],
    sun: new THREE.Color(p.sun), sky: new THREE.Color(p.sky), ground: new THREE.Color(p.ground), fog: new THREE.Color(p.fog) };
});
const sunHeight = (hour) => Math.sin(Math.PI * (hour - 6.5) / 13);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class World {
  constructor(scene, renderer, track) {
    this.scene = scene; this.renderer = renderer; this.track = track;
    this.theme = THEMES[track.id] ?? THEMES['harbor-ring'];
    this.root = new THREE.Group(); this.root.name = `${track.name} (static)`; scene.add(this.root);
    this.live = new THREE.Group(); this.live.name = `${track.name} (animated)`; scene.add(this.live);
    this.rng = random(20260930); this.dummy = new THREE.Object3D(); this.animators = []; this.smoke = [];
    const b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    for (let s = 0; s < track.length; s += 10) { const p = track.at(s); b.x0 = Math.min(b.x0, p.x); b.x1 = Math.max(b.x1, p.x); b.z0 = Math.min(b.z0, p.z); b.z1 = Math.max(b.z1, p.z); }
    this.bounds = { ...b, cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2, r: Math.hypot(b.x1 - b.x0, b.z1 - b.z0) / 2 };
    scene.fog = new THREE.FogExp2('#d4ccba', .00045);

    this.sky = new Sky(); this.sky.scale.setScalar(9000); scene.add(this.sky);
    const u = this.sky.material.uniforms; u.mieCoefficient.value = .005; u.mieDirectionalG.value = .88;
    this.buildClouds();
    this.sun = new THREE.DirectionalLight('#fff0d2', 3.8); this.sun.castShadow = true; this.sun.shadow.mapSize.set(4096, 4096);
    Object.assign(this.sun.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 1, far: 320 });
    this.sun.shadow.bias = -.00012; this.sun.shadow.normalBias = .028;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight('#c5dbe5', '#746646', 1); scene.add(this.hemi);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.setLighting(this.theme.lighting);
    // One beam for the focused car, always in the scene so turning it on never recompiles shaders.
    this.headlight = new THREE.SpotLight('#eef4ff', 0, 160, .34, .7, 1.6); scene.add(this.headlight, this.headlight.target);
    this.lamps = 0; this.dark = this.theme.lighting === 'night' ? 1 : 0;

    this.clearOf = (x, z, r = 0) => Math.abs(track.nearest(x, z).lateral) > track.barrierOffset + 2.5 + r;
    // Pit lane geometry, identical to the one the race builds (core/pit.js).
    this.lane = track.scenario?.pit ? new PitLane(track, 12) : null;
    const lane = this.lane, gapFrom = lane ? wrap(lane.boxStart - 34, track.length) : 0, gapTo = lane ? wrap(lane.boxEnd + 34, track.length) : 0;
    // The garages open straight onto the lane: no barrier on the pit side there.
    this.pitGap = (s, side) => !!lane && side === lane.side && lane.inWindow(wrap(s, track.length), gapFrom, gapTo);
    this.buildTrack(); this.buildGround(); this.buildTrackside(); this.buildPitLane(); this.buildPaddock(); this.buildStands();
    if (this.theme.harbor) this.buildHarbor();
    this.buildCity(); this.buildHills(); this.buildNature(); this.buildSkyLife();
    if (this.theme.rocks) this.buildDesert();
    this.buildStars();
    this.root.traverse((o) => { o.updateMatrix(); o.matrixAutoUpdate = false; });
    this.centre = new THREE.Vector3(); this.shadowRight = new THREE.Vector3(); this.shadowUp = new THREE.Vector3();
    this.clock = performance.now() / 1000; this.screenTick = -1;
  }

  setLighting(mode = this.theme.lighting) {
    this.lightMode = mode;
    const p = LIGHTING[mode] || LIGHTING.golden;
    this.sunDirection = new THREE.Vector3(.7, p.elevation, .65).normalize();
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(p.skyElevation != null ? new THREE.Vector3(.7, p.skyElevation, .65).normalize() : this.sunDirection);
    u.turbidity.value = p.turbidity; u.rayleigh.value = { overcast: .4, night: .3, dusk: 2.4 }[mode] ?? 1.6;
    this.sun.intensity = p.intensity * (mode === 'overcast' ? .7 : 1.18); this.hemi.intensity = p.fill * .55;
    this.sun.color.set(p.sun); this.hemi.color.set(p.sky); this.hemi.groundColor.set(p.ground);
    this.scene.fog.color.set(p.fog); this.scene.fog.density = p.density * .8; this.renderer.toneMappingExposure = p.exposure * .95;
    const cu = this.clouds.material.uniforms;
    cu.uSun.value.copy(this.sunDirection); cu.uCover.value = { golden: .5, day: .56, overcast: .26, dusk: .6, night: .72 }[mode] ?? .5;
    if (this.mastHeads) this.mastHeads.material.emissiveIntensity = mode === 'night' ? 7 : .6;
    cu.uLit.value.set(p.sun).multiplyScalar(mode === 'overcast' ? .9 : 1.25); cu.uShade.value.set(p.fog).multiplyScalar(.62);
    this.bakeEnvironment(new THREE.Color(p.ground)); this.scene.environmentIntensity = p.environment * 1.15;
  }

  // Blend the lighting presets for a clock hour. The sky and lights follow every
  // call; the reflection environment is re-baked only when the sun has moved enough.
  // `cloud` 0..1 dims and greys the sun, thickens the cloud deck and the haze;
  // `rain` 0..~.55 adds murk and switches the lamps on.
  setTimeOfDay(hour, cloud = 0, rain = 0) {
    if (hour === this.hour && cloud === this.cloud && rain === this.rain) return;
    this.hour = hour; this.cloud = cloud; this.rain = rain;
    const h = ((hour % 24) + 24) % 24, y = sunHeight(h);
    let i = 0; while (i < SKY_STOPS.length - 2 && y > SKY_STOPS[i + 1].y) i++;
    const a = SKY_STOPS[i], b = SKY_STOPS[i + 1], t = clamp((y - a.y) / (b.y - a.y), 0, 1);
    const mix = (k) => a.p[k] + (b.p[k] - a.p[k]) * t, col = (k, out) => out.copy(a[k]).lerp(b[k], t);
    const dark = this.dark = smooth(.1, -.1, y);
    // Lamps come on in the gloom before the floodlit dark.
    this.lamps = Math.max(smooth(.24, .02, y), Math.min(1, rain * 4) * .8);
    const swing = (h - this.theme.hour) * .12 * (1 - dark), sx = .7 * Math.cos(swing) - .65 * Math.sin(swing), sz = .7 * Math.sin(swing) + .65 * Math.cos(swing);
    this.sunDirection = new THREE.Vector3(sx, mix('elevation'), sz).normalize();
    const u = this.sky.material.uniforms;
    u.sunPosition.value.set(sx, clamp(y, -.12, 1), sz).normalize();
    u.turbidity.value = mix('turbidity') + 9 * cloud; u.rayleigh.value = (a.rayleigh + (b.rayleigh - a.rayleigh) * t) * (1 - .5 * cloud);
    this.sun.intensity = mix('intensity') * 1.18 * (1 - .72 * cloud); this.hemi.intensity = mix('fill') * .55 * (1 + .3 * cloud);
    col('sun', this.sun.color); col('sky', this.hemi.color); col('ground', this.hemi.groundColor);
    col('fog', this.scene.fog.color); this.scene.fog.density = mix('density') * .8 * (1 + .5 * cloud + 2.5 * rain); this.renderer.toneMappingExposure = mix('exposure') * .95 * (1 - .1 * cloud);
    // Overcast light is grey: wash the sun, sky and haze towards their own luminance.
    for (const c of [this.sun.color, this.hemi.color, this.scene.fog.color]) { const l = c.r * .3 + c.g * .59 + c.b * .11; c.lerp(GREY.setScalar(l * 1.05), .65 * cloud); }
    const cu = this.clouds.material.uniforms;
    cu.uSun.value.copy(this.sunDirection); cu.uCover.value = THREE.MathUtils.lerp(a.cover + (b.cover - a.cover) * t, .04, cloud);
    cu.uLit.value.copy(this.sun.color).multiplyScalar(1.25 * (1 - .45 * cloud)); cu.uShade.value.copy(this.scene.fog.color).multiplyScalar(.62);
    if (this.mastHeads) this.mastHeads.material.emissiveIntensity = .6 + 6.4 * dark;
    if (this.stars) { this.stars.material.opacity = .85 * dark; this.stars.visible = dark > .01; }
    this.scene.environmentIntensity = mix('environment') * 1.15 * (1 - .3 * cloud);
    const now = performance.now();
    if (this.envY == null || ((Math.abs(y - this.envY) > .04 || Math.abs(cloud - this.envCloud) > .08) && now - this.envAt > 1200)) {
      this.envY = y; this.envCloud = cloud; this.envAt = now;
      this.bakeEnvironment(this.hemi.groundColor);
    }
  }

  bakeEnvironment(groundColor) {
    const env = new THREE.Scene(); env.add(this.sky.clone());
    const ground = new THREE.Mesh(new THREE.CircleGeometry(95, 32), new THREE.MeshBasicMaterial({ color: groundColor.clone().multiplyScalar(.55) }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -6; env.add(ground);
    const target = this.pmrem.fromScene(env, .02); this.envTarget?.dispose(); this.envTarget = target;
    this.scene.environment = target.texture;
    ground.geometry.dispose(); ground.material.dispose();
  }

  buildClouds() {
    const material = new THREE.ShaderMaterial({
      uniforms: { uTime: TIME, uSun: { value: new THREE.Vector3() }, uLit: { value: new THREE.Color() }, uShade: { value: new THREE.Color() }, uCover: { value: .5 } },
      vertexShader: `varying vec3 vDir;void main(){vDir=normalize(position);vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.);gl_Position=p;gl_Position.z=p.w*.99999;}`,
      fragmentShader: `uniform float uTime;uniform vec3 uSun;uniform vec3 uLit;uniform vec3 uShade;uniform float uCover;varying vec3 vDir;
        float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
        float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<6;i++){v+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}
        void main(){
          vec3 d=normalize(vDir);if(d.y<0.)discard;
          vec2 uv=d.xz/(d.y+.1)*1.3;vec2 w=vec2(uTime*.006,uTime*.0022);
          float dens=fbm(uv+w);float c=smoothstep(uCover,uCover+.3,dens);
          float sh=fbm(uv+w+uSun.xz*.08);float lit=clamp(.5+(dens-sh)*3.2,0.,1.);
          vec3 col=mix(uShade,uLit,lit);col+=uLit*pow(max(dot(d,uSun),0.),6.)*.8*(1.-c*.5);
          gl_FragColor=vec4(col,c*smoothstep(.0,.22,d.y)*.9);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, side: THREE.BackSide, fog: false
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(8000, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), material);
    this.clouds.frustumCulled = false; this.clouds.renderOrder = -1; this.scene.add(this.clouds);
  }

  buildTrack() {
    const t = this.track;
    const asphalt = asphaltMaps();
    this.roadMaterial = new THREE.MeshPhysicalMaterial({ ...asphalt, color: '#ffffff', roughness: 1, metalness: 0, clearcoat: 0, clearcoatRoughness: .08, normalScale: new THREE.Vector2(.9, .9) });
    // Macro variation breaks tiling: patch repairs, darker oil line, lighter worn edges.
    this.roadMaterial.onBeforeCompile = (s) => {
      s.vertexShader = 'varying vec2 vRoad;\n' + s.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvRoad=uv;');
      s.fragmentShader = 'varying vec2 vRoad;\n' + s.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        float lat=vRoad.x*4.-${t.halfWidth.toFixed(2)};
        float patchA=step(.72,fract(sin(floor(vRoad.y*.09)*91.7)*437.1))*step(abs(lat-sin(floor(vRoad.y*.09)*3.)*4.),2.2);
        float macro=sin(vRoad.y*.21+sin(vRoad.x*1.3))*.5+.5;
        diffuseColor.rgb*=mix(.9,1.07,macro)*mix(1.,.8,patchA);
        diffuseColor.rgb*=1.-.1*exp(-lat*lat*.08);
        diffuseColor.rgb*=1.+.08*smoothstep(${(t.halfWidth - 1.4).toFixed(2)},${t.halfWidth.toFixed(2)},abs(lat));`);
    };
    this.road = add(this.root, ribbon(t, -t.halfWidth, t.halfWidth, .018, 1400), this.roadMaterial, 0, 0, 0, false);
    const gravel = repeatMaps(gravelMaps(), .6, .6), lineMat = std('#ecebe2', .55, 0, decal(2));
    for (const side of [-1, 1]) {
      add(this.root, ribbon(t, side * (t.halfWidth + t.curbWidth), side * (t.halfWidth + t.curbWidth + t.runoffWidth - 1), .005, 900),
        new THREE.MeshStandardMaterial({ ...gravel, roughness: 1, normalScale: new THREE.Vector2(1.4, 1.4), side: THREE.DoubleSide }), 0, 0, 0, false);
      add(this.root, ribbon(t, side * (t.halfWidth - .24), side * (t.halfWidth - .1), .026, 1400), lineMat, 0, 0, 0, false);
    }
    // Profiled kerbs: raised sausage with 2.5 m red/white paint and wear.
    const stripe = canvasTexture(64, 256, (c) => {
      c.fillStyle = '#c3301f'; c.fillRect(0, 0, 64, 128); c.fillStyle = '#ebe9df'; c.fillRect(0, 128, 64, 128);
      const rng = random(4); for (let i = 0; i < 500; i++) { c.fillStyle = `rgba(30,28,26,${rng() * .18})`; c.fillRect(rng() * 64, rng() * 256, 1 + rng() * 3, 1 + rng() * 6); }
    });
    const kerbMat = new THREE.MeshStandardMaterial({ map: stripe, roughness: .62, normalMap: asphalt.normalMap, normalScale: new THREE.Vector2(.25, .25) });
    const w = t.curbWidth, kerbProfile = [[-.02, .02], [.12, .06], [.35, .075], [w - .35, .075], [w - .1, .05], [w, .02]];
    for (const side of [-1, 1]) add(this.root, sweep(t, kerbProfile, t.halfWidth, side, 1400, 5), kerbMat, 0, 0, 0, false);

    // Rubber build-up mesh, identical lane layout to the host.
    const positions = [], colors = [];
    for (let i = 0; i < t.nodes.length; i++) for (let lane = 0; lane < 13; lane++) {
      const left = lane * t.laneWidth - t.halfWidth, right = left + t.laneWidth, next = t.nodes[(i + 1) % t.nodes.length].s;
      const a = t.at(t.nodes[i].s, left), b = t.at(t.nodes[i].s, right), c = t.at(next, left), d = t.at(next, right);
      for (const p of [a, b, c, b, d, c]) { positions.push(p.x, .036, p.z); colors.push(1, 1, 1); }
    }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); rg.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.rubberMesh = add(this.root, rg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: .3, blending: THREE.MultiplyBlending, depthWrite: false, side: THREE.DoubleSide, ...decal(3) }), 0, 0, 0, false);

    // Start/finish chequer and grid boxes.
    const p = t.at(t.finishS), start = new THREE.Group(); start.position.set(p.x, .03, p.z); start.rotation.y = p.heading; this.root.add(start);
    const chequer = canvasTexture(256, 32, (c) => { for (let x = 0; x < 16; x++) for (let z = 0; z < 2; z++) { c.fillStyle = (x + z) % 2 ? '#1d201f' : '#efeee6'; c.fillRect(x * 16, z * 16, 16, 16); } });
    chequer.magFilter = THREE.NearestFilter;
    const line = add(start, new THREE.PlaneGeometry(t.width, 1.2), std('#ffffff', .6, 0, { map: chequer, ...decal(2) }), 0, 0, .3, false); line.rotation.x = -Math.PI / 2;
    const gridMat = std('#e6e5dc', .6, 0, decal(2));
    for (let i = 0; i < 8; i++) {
      const q = t.at(t.gridS - Math.floor(i / 2) * (t.scenario?.start.rowSpacingM ?? 9.5), (i % 2 ? -1 : 1) * (t.scenario?.start.laneOffsetM ?? 2.3));
      const g = new THREE.Group(); g.position.set(q.x, .04, q.z); g.rotation.y = q.heading; this.root.add(g);
      for (const x of [-1.1, 1.1]) box(g, gridMat, x, 0, -.5, .1, .01, 4.8, false);
      box(g, gridMat, 0, 0, 1.9, 2.3, .01, .12, false);
      const num = add(g, new THREE.PlaneGeometry(1.1, .55), new THREE.MeshStandardMaterial({ map: signTexture(String(i + 1), '', { bg: '#1a1d1c', fg: '#f0efe6', w: 256, h: 128, italic: false }), roughness: .7, ...decal(3) }), 0, .012, 1.35, false);
      num.rotation.x = -Math.PI / 2; num.rotation.z = Math.PI;
    }
  }

  buildGround() {
    const grass = repeatMaps(grassMaps(), 700, 700);
    const material = new THREE.MeshStandardMaterial({ ...grass, roughness: 1, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 });
    material.onBeforeCompile = (s) => {
      s.vertexShader = 'varying vec3 vW;\n' + s.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvW=(modelMatrix*vec4(transformed,1.)).xyz;');
      s.fragmentShader = 'varying vec3 vW;\n' + s.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        float a=sin(vW.x*.011+sin(vW.z*.008)*2.)*sin(vW.z*.015+1.3);float b=sin(vW.x*.041+vW.z*.037)*.5+.5;
        diffuseColor.rgb*=mix(vec3(.78,.84,.66),vec3(1.12,1.04,.82),a*.5+.5)*mix(.92,1.06,b);
        float mow=step(.5,fract(vW.x*.05+vW.z*.02));diffuseColor.rgb*=mix(.96,1.04,mow);`);
    };
    // Sand and alpine meadow are tints of the same grass shader.
    const tint = { sand: 'diffuseColor.rgb=vec3(dot(diffuseColor.rgb,vec3(.3,.59,.11)))*vec3(2.2,1.62,1.1);', alpine: 'diffuseColor.rgb*=vec3(.8,.92,.9);' }[this.theme.ground];
    if (tint) {
      const base = material.onBeforeCompile;
      material.onBeforeCompile = (sh) => { base(sh); sh.fragmentShader = sh.fragmentShader.replace('float mow=', tint + 'float mow='); };
      material.customProgramCacheKey = () => `ground-${this.theme.ground}`;
    }
    if (this.theme.harbor) {
      // Terrain stops at the quay edge; the sea takes over east of x=770.
      const west = -3200, east = 770, ground = add(this.root, new THREE.PlaneGeometry(east - west, 6400), material, (east + west) / 2, -.055, 0, false);
      ground.rotation.x = -Math.PI / 2;
    } else {
      const ground = add(this.root, new THREE.PlaneGeometry(9000, 9000), material, this.bounds.cx, -.055, this.bounds.cz, false);
      ground.rotation.x = -Math.PI / 2;
    }
  }

  buildTrackside() {
    const t = this.track, d = this.dummy, rng = this.rng, concrete = concreteMaps();
    // Jersey barriers with a painted top band.
    const barrierMat = new THREE.MeshStandardMaterial({ ...repeatMaps(concrete, .5, .5), color: '#d8d6cc', roughness: .9 });
    const jersey = [[0, 0], [.06, .25], [.2, .55], [.24, .95], [.5, .95], [.54, .55], [.68, .25], [.74, 0]];
    for (const side of [-1, 1]) add(this.root, sweep(t, jersey, t.barrierOffset + .7, side, 1500, 3, { skip: (s) => this.pitGap(s, side) }), barrierMat);
    // Catch fence with posts; sponsor boards mounted in front.
    const fmap = fenceTexture().clone(); fmap.needsUpdate = true;
    const fenceMat = new THREE.MeshStandardMaterial({ map: fmap, alphaTest: .35, side: THREE.DoubleSide, roughness: .5, metalness: .6, color: '#b9bfbf' });
    for (const side of [-1, 1]) {
      const pos = [], uv = [], ix = [], n = 900;
      for (let i = 0; i <= n; i++) { const s = i / n * t.length, p = t.at(s, side * (t.barrierOffset + 1.35)); pos.push(p.x, .95, p.z, p.x, 4.2, p.z); uv.push(s * 1.6, 0, s * 1.6, 5.2); if (i < n && !this.pitGap(s + t.length / n / 2, side)) { const a = i * 2; ix.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(ix); g.computeVertexNormals();
      add(this.root, g, fenceMat, 0, 0, 0, false);
    }
    const postCount = Math.ceil(t.length / 5) * 2, posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(.05, .06, 4.4, 6), std('#6f7674', .45, .7), postCount); let k = 0;
    for (const side of [-1, 1]) for (let s = 0; s < t.length; s += 5) { if (this.pitGap(s, side)) continue; const p = t.at(s, side * (t.barrierOffset + 1.4)); d.position.set(p.x, 2.2, p.z); d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1); d.updateMatrix(); posts.setMatrixAt(k++, d.matrix); }
    posts.count = k; posts.castShadow = true; this.root.add(posts);
    const boardGeo = new THREE.PlaneGeometry(7.6, 1.1), boards = SPONSORS.map((_, i) => { const m = new THREE.InstancedMesh(boardGeo, new THREE.MeshStandardMaterial({ map: sponsorTexture(i), roughness: .55 }), 200); m.count = 0; m.castShadow = true; this.root.add(m); return m; });
    let b = 0;
    for (const side of [-1, 1]) for (let s = 3; s < t.length - 8; s += 8.4) {
      if (this.pitGap(s - 4, side) || this.pitGap(s + 4, side)) continue;
      const a = t.at(s, side * (t.barrierOffset + 1.28)); const mesh = boards[(b++ * 7 + (side > 0 ? 3 : 0)) % boards.length];
      d.position.set(a.x, 1.72, a.z); d.rotation.set(0, a.heading - side * Math.PI / 2, 0); d.updateMatrix(); mesh.setMatrixAt(mesh.count++, d.matrix);
    }
    // Tyre walls on the outside of the fast corners.
    const tyres = new THREE.InstancedMesh(new THREE.CylinderGeometry(.34, .34, .95, 14, 1, true), std('#1a1b1c', .9), 1400); tyres.count = 0;
    const belt = std('#1d5fa8', .6); const beltGeo = [];
    for (let s = 0; s < t.length; s += 4) {
      const p = t.at(s); if (Math.abs(p.curvature) < .009) continue;
      const side = -Math.sign(p.curvature);
      for (const row of [0, 1]) { const q = t.at(s + row * 2, side * (t.barrierOffset + .25)); d.position.set(q.x, .47, q.z); d.rotation.set(0, 0, 0); d.updateMatrix(); if (tyres.count < 1400) tyres.setMatrixAt(tyres.count++, d.matrix); }
      const q = t.at(s + 1, side * (t.barrierOffset - .15)); const g = new THREE.BoxGeometry(.04, 1, 4.05); g.rotateY(q.heading); g.translate(q.x, .5, q.z); beltGeo.push(g);
    }
    tyres.castShadow = true; this.root.add(tyres);
    if (beltGeo.length) add(this.root, mergeGeometries(beltGeo), belt);

    // Distance boards before the braking zones.
    for (const distance of this.theme.harbor ? [610, 1240, 1700, 2110, 2510] : this.brakingZones()) for (const n of [150, 100, 50]) {
      const p = t.at(distance - n, -(t.halfWidth + t.curbWidth + 3.5)), g = new THREE.Group(); g.position.set(p.x, 0, p.z); g.rotation.y = p.heading + Math.PI; this.root.add(g);
      add(g, new THREE.PlaneGeometry(1.2, 1.3), new THREE.MeshStandardMaterial({ map: signTexture(String(n), '', { bg: '#f1f0ea', fg: '#16191a', accent: '#e8483a', w: 256, h: 256, italic: false }), roughness: .6 }), 0, 1.1, 0);
      box(g, std('#3b4041', .5, .6), 0, .4, .03, .08, .8, .05);
    }
    // Floodlight masts, marshal posts and a footbridge.
    const mastGeo = new THREE.CylinderGeometry(.18, .32, 26, 8), headGeo = new THREE.BoxGeometry(3.4, 1.6, .5);
    const masts = new THREE.InstancedMesh(mastGeo, std('#8c9392', .4, .8), 80), heads = this.mastHeads = new THREE.InstancedMesh(headGeo, std('#dfe6ee', .3, .2, { emissive: '#fff4dc', emissiveIntensity: this.lightMode === 'night' ? 7 : .6 }), 80); masts.count = heads.count = 0;
    for (let s = 40, i = 0; s < t.length; s += 135, i++) {
      const side = i % 2 ? 1 : -1, p = t.at(s, side * (t.barrierOffset + 7)); if (!this.clearOf(p.x, p.z, 1)) continue;
      d.position.set(p.x, 13, p.z); d.rotation.set(0, p.heading, 0); d.updateMatrix(); masts.setMatrixAt(masts.count++, d.matrix);
      d.position.y = 26.5; d.rotation.set(-.35 * side, p.heading + Math.PI / 2, 0); d.updateMatrix(); heads.setMatrixAt(heads.count++, d.matrix);
    }
    masts.castShadow = heads.castShadow = true; this.root.add(masts, heads);
    const huts = std('#e37a1f', .7), flagMats = ['#1f9e3a', '#f3d21c', '#1e5bd6'].map((c) => sway(new THREE.MeshStandardMaterial({ color: c, roughness: .8, side: THREE.DoubleSide }), .07, 'flag', 'flag'));
    for (let s = 120, i = 0; s < t.length; s += 290, i++) {
      const side = i % 2 ? -1 : 1, p = t.at(s, side * (t.barrierOffset + 3)); if (!this.clearOf(p.x, p.z, 0)) continue;
      const g = new THREE.Group(); g.position.set(p.x, 0, p.z); g.rotation.y = p.heading; this.root.add(g);
      box(g, huts, 0, 1.2, 0, 2, 2.4, 2); box(g, std('#2b2f30', .6), 0, 2.45, 0, 2.3, .12, 2.3);
      add(g, new THREE.CylinderGeometry(.03, .03, 3.8), std('#cccccc', .3, .8), -side * .9, 2.8, .9);
      const flag = add(this.live, new THREE.PlaneGeometry(1.2, .8, 12, 1), flagMats[i % 3]); flag.position.set(p.x, 4.2, p.z); flag.rotation.y = p.heading; flag.geometry.translate(.6, 0, 0);
    }
    const bp = t.at(this.theme.harbor || !this.lane ? 455 : this.lane.exit + 40), bridge = new THREE.Group(); bridge.position.set(bp.x, 0, bp.z); bridge.rotation.y = bp.heading; this.root.add(bridge);
    const steel = std('#c9ced0', .35, .8), span = (t.barrierOffset + 4) * 2;
    box(bridge, std('#50585b', .5, .6), 0, 7.2, 0, span, .7, 3.6);
    for (const x of [-span / 2, span / 2]) { box(bridge, concreteMat(), x, 3.6, 0, 1.6, 7.2, 3.2); box(bridge, steel, x, 9, 0, .2, 3.6, .2); }
    for (const z of [-1.7, 1.7]) { box(bridge, steel, 0, 8.6, z, span, .08, .08); for (let x = -span / 2; x <= span / 2; x += 2) box(bridge, steel, x, 8.1, z, .06, 1.1, .06, false); }
    box(bridge, steel, 0, 10.8, 0, span, .25, 4);
    for (const z of [-1.95, 1.95]) { const banner = add(bridge, new THREE.PlaneGeometry(span - 4, 2.2), new THREE.MeshStandardMaterial({ map: sponsorTexture(z > 0 ? 0 : 1, 2048, 256), roughness: .6 }), 0, 6.1, z); banner.rotation.y = z > 0 ? 0 : Math.PI; }
    function concreteMat() { return new THREE.MeshStandardMaterial({ ...concrete, roughness: .9 }); }
  }

  // Pit lane: asphalt lane, concrete garage apron, painted lines, pit wall and
  // limit boards. Team box markings come from setPitBoxes() once a race exists.
  buildPitLane() {
    const t = this.track, lane = this.lane; if (!lane) return;
    const L = t.length, side = lane.side, kerb = side * (t.halfWidth + t.curbWidth);
    const apron = side * (t.barrierOffset + 2.95), boxOuter = lane.boxLat + side * 3.4;
    const zoneA = wrap(lane.boxStart - 34, L), zoneB = wrap(lane.boxEnd + 34, L), zoneLen = lane.d(zoneA, zoneB);
    // Garage zone widens smoothly from the lane out to the building.
    const widen = (s) => lane.inWindow(s, zoneA, zoneB) ? smooth01(Math.min(lane.d(zoneA, s), lane.d(s, zoneB)) / 16) : 0;
    const laneOuter = (s) => { const o = lane.laneAt(s) + side * 3.6; return side < 0 ? Math.min(o, kerb - .6) : Math.max(o, kerb + .6); };
    const outer = (s) => laneOuter(s) + (apron - laneOuter(s)) * widen(s);
    const flat = (from, length, a, b, y, mat, step) => add(this.root, band(t, wrap(from, L), length, a, b, y, step), mat, 0, 0, 0, false);
    const pitMat = new THREE.MeshStandardMaterial({ ...asphaltMaps(), color: '#dedcd6', roughness: .95, normalScale: new THREE.Vector2(.7, .7), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    flat(lane.entry, lane.length, () => kerb, outer, .021, pitMat, 1.2);
    const concreteMat = new THREE.MeshStandardMaterial({ ...repeatMaps(concreteMaps(), .25, .25), color: '#c9c6bd', roughness: .9, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    flat(zoneA + 16, zoneLen - 32, () => boxOuter, () => apron, .024, concreteMat, 2);
    // Paint: lane edges, the fast-lane / working-lane divider and limit lines.
    const paintOpts = { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 };
    const paint = std('#eeede4', .5, 0, paintOpts), yellow = std('#f0c31c', .5, 0, paintOpts);
    const line = (from, length, lat, w, mat) => flat(from, length, (s) => lat(s) - w / 2, (s) => lat(s) + w / 2, .03, mat, 1);
    const trackEdge = (s) => lane.laneAt(s) - side * 3.4, outerEdge = (s) => lane.laneAt(s) + side * 3.4;
    line(lane.entry, lane.length, trackEdge, .2, paint);   // pit entry/exit line
    line(lane.entry, lane.d(lane.entry, zoneA) + 16, outerEdge, .15, paint);
    line(zoneB - 16, lane.d(zoneB, lane.exit) + 16, outerEdge, .15, paint);
    const divider = lane.boxLat - side * 3.2;
    for (let u = 16; u < zoneLen - 19; u += 6) line(zoneA + u, 3, () => divider, .15, yellow);
    const across = (s, w, mat) => {
      const p = t.at(wrap(s, L), lane.laneAt(wrap(s, L))), g = new THREE.Group(); g.position.set(p.x, .031, p.z); g.rotation.y = p.heading; this.root.add(g);
      const m = add(g, new THREE.PlaneGeometry(6.8, w), mat, 0, 0, 0, false); m.rotation.x = -Math.PI / 2;
    };
    const limitEnd = wrap(lane.exit - lane.exitRamp, L);
    for (const s of [lane.limiter, limitEnd]) { across(s, .6, paint); across(s + 1.2, .3, yellow); }
    // Limit boards at both ends of the speed-limited section.
    const kph = Math.round(lane.limit * 3.6);
    for (const [s, text] of [[lane.limiter - 4, `${kph}`], [limitEnd, 'END']]) {
      const p = t.at(wrap(s, L), lane.laneAt(wrap(s, L)) + side * 4.1), g = new THREE.Group(); g.position.set(p.x, 0, p.z); g.rotation.y = p.heading + Math.PI; this.root.add(g);
      add(g, new THREE.PlaneGeometry(1.1, 1.1), new THREE.MeshStandardMaterial({ map: signTexture(text, '', { bg: '#f4f3ee', fg: '#16191a', accent: '#d9281f', w: 256, h: 256, italic: false }), roughness: .6, side: THREE.DoubleSide }), 0, 1.75, 0);
      box(g, std('#3b4041', .5, .6), 0, .95, .03, .07, 1.9, .05);
    }
    // Pit wall with a painted face and a debris fence on top.
    const w = lane.wall, wallLen = lane.d(w.from, w.to), off = Math.abs(w.lat) - w.half, steps = Math.ceil(wallLen / 2), span = { from: w.from, length: wallLen };
    const wallProfile = [[0, 0], [0, 1.05], [0, 1.05], [.02, 1.1], [.33, 1.1], [.35, 1.05], [.35, 1.05], [.35, 0]];
    add(this.root, sweep(t, wallProfile, off, side, steps, 3, span), new THREE.MeshStandardMaterial({ ...repeatMaps(concreteMaps(), .5, .5), color: '#e7e5dd', roughness: .85 }));
    add(this.root, sweep(t, [[-.006, .42], [-.006, .12]], off, side, steps, 3, span), std('#d23a24', .6, 0, { side: THREE.DoubleSide }), 0, 0, 0, false);
    const fmap = fenceTexture().clone(); fmap.needsUpdate = true;
    add(this.root, sweep(t, [[.175, 1.1], [.175, 3.3]], off, side, steps, 1 / 1.6, span), new THREE.MeshStandardMaterial({ map: fmap, alphaTest: .35, side: THREE.DoubleSide, roughness: .5, metalness: .6, color: '#b9bfbf' }), 0, 0, 0, false);
    // Pit-wall stands every 30 m on the lane side of the wall.
    const standMat = std('#2c3234', .5, .4), roofMat = std('#e9e8e2', .5, .2), screen = std('#0d1112', .3, 0, { emissive: '#3aa0ff', emissiveIntensity: .5 });
    for (let u = 30; u < wallLen - 20; u += 30) {
      const p = t.at(wrap(w.from + u, L), w.lat + side * .55), g = new THREE.Group(); g.position.set(p.x, 0, p.z); g.rotation.y = p.heading; this.root.add(g);
      box(g, standMat, 0, .6, 0, .7, 1.2, 3.6); box(g, roofMat, 0, 2.7, 0, 1.4, .08, 4); box(g, standMat, 0, 1.9, 1.9, .08, 1.6, .08); box(g, standMat, 0, 1.9, -1.9, .08, 1.6, .08);
      box(g, screen, -side * .36, 1.45, 0, .04, .5, 2.8, false);
    }
  }

  /** Team box markings in front of the garages, one per team, in the order of `lane.boxes`. */
  setPitBoxes(lane, teams) {
    if (this.pitBoxes) { this.pitBoxes.traverse((o) => { o.geometry?.dispose(); if (o.material && !o.material.userData.shared) o.material.dispose(); }); this.root.remove(this.pitBoxes); this.pitBoxes = null; }
    if (!lane || !this.lane) return;
    const t = this.track, group = this.pitBoxes = new THREE.Group(); group.name = 'Pit boxes'; this.root.add(group);
    const white = std('#f2f1ea', .5, 0, { polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -10 }); white.userData.shared = true;
    const len = Math.min(8, lane.d(lane.boxStart, lane.boxEnd) / Math.max(1, teams.length) - 1.2);
    teams.forEach((team, i) => {
      const s = lane.boxes[i]; if (s == null) return;
      const p = t.at(s, lane.boxLat), g = new THREE.Group(); g.position.set(p.x, .034, p.z); g.rotation.y = p.heading; group.add(g);
      const fill = add(g, new THREE.PlaneGeometry(4.8, len), new THREE.MeshStandardMaterial({ color: team.color, roughness: .55, transparent: true, opacity: .5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }), 0, 0, 0, false); fill.rotation.x = -Math.PI / 2;
      for (const x of [-2.4, 2.4]) { const e = add(g, new THREE.PlaneGeometry(.18, len), white, x, .002, 0, false); e.rotation.x = -Math.PI / 2; }
      for (const z of [-len / 2, len / 2]) { const e = add(g, new THREE.PlaneGeometry(4.98, .18), white, 0, .002, z, false); e.rotation.x = -Math.PI / 2; }
      const plate = add(g, new THREE.PlaneGeometry(len * .6, 1.1), new THREE.MeshStandardMaterial({ map: signTexture(team.short ?? team.name, '', { bg: team.color, fg: '#ffffff', accent: '#111111', w: 512, h: 128, italic: false }), roughness: .6, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -10 }), side3(lane) * 1.4, .004, 0, false);
      plate.rotation.set(-Math.PI / 2, 0, lane.side < 0 ? -Math.PI / 2 : Math.PI / 2);
      // Lollipop on the garage side of the box.
      const q = t.at(s, lane.boxLat + lane.side * 3.1), pole = new THREE.Group(); pole.position.set(q.x, 0, q.z); pole.rotation.y = q.heading; group.add(pole);
      box(pole, std('#d9d9d4', .4, .7), 0, 1, 0, .05, 2, .05);
      box(pole, std(team.color, .45), 0, 2.05, 0, .06, .5, .5);
    });
    group.traverse((o) => { o.updateMatrix(); o.matrixAutoUpdate = false; });
    group.updateMatrixWorld(true);
  }

  buildPaddock() {
    const t = this.track, concrete = concreteMaps();
    const cmat = new THREE.MeshStandardMaterial({ ...repeatMaps(concrete, 6, 1), roughness: .88 });
    const glass = new THREE.MeshPhysicalMaterial({ color: '#27454d', roughness: .05, metalness: .85, clearcoat: 1, envMapIntensity: 1.6 });
    const dark = std('#23292b', .6, .3), metal = std('#9aa3a4', .35, .85);
    // Pit building: garages with lit interiors, glass hospitality level, roof sign.
    const boxMid = this.theme.harbor || !this.lane ? 210 : (this.lane.boxStart + this.lane.boxEnd) / 2;
    const p = t.at(boxMid, -32), pits = new THREE.Group(); pits.position.set(p.x, 0, p.z); pits.rotation.y = p.heading; this.root.add(pits);
    box(pits, std('#8f8e88', .95), -4, .02, 0, 34, .08, 196, false);
    box(pits, cmat, -1, 2.3, 0, 12, 4.6, 172);
    box(pits, glass, 0, 6.2, 0, 11, 3.2, 170);
    box(pits, dark, -.5, 7.95, 0, 14, .35, 176);
    box(pits, metal, 5.3, 4.7, 0, 3, .15, 172);
    for (let z = -84; z <= 84; z += 6) box(pits, metal, 6.7, 5.3, z, .05, 1.1, .05, false);
    box(pits, metal, 6.7, 5.85, 0, .06, .06, 170, false);
    const lamp = std('#ffffff', .4, 0, { emissive: '#fff3dc', emissiveIntensity: 2.4 });
    for (let i = 0; i < 17; i++) {
      const z = -80 + i * 10;
      box(pits, std('#3a4144', .8), 4.4, 1.9, z, 2.8, 3.6, 8.6, false);
      box(pits, std('#d8dde0', .5), 3.2, 1.9, z, .05, 3.5, 8.4, false);
      box(pits, lamp, 4.4, 3.6, z, 2.4, .05, .25, false);
      box(pits, metal, 5.78, 3.35, z, .08, .8, 8.6, false);
      const team = add(pits, new THREE.PlaneGeometry(8, 1), new THREE.MeshStandardMaterial({ map: sponsorTexture(i), roughness: .5 }), 5.84, 4.1, z); team.rotation.y = Math.PI / 2;
      for (let j = 0; j < 3; j++) box(pits, std(['#c43b25', '#1b2a6b', '#f2c230'][(i + j) % 3], .4, .4), 3.6 + (j % 2) * .1, .55, z - 3 + j * 1.2, .6, 1.1, .5);
      box(pits, cmat, 5.8, 2, z - 5, .35, 4, .4);
    }
    const sign = add(pits, new THREE.PlaneGeometry(40, 5), new THREE.MeshStandardMaterial({ map: sponsorTexture(0, 2048, 256), roughness: .5, emissive: '#ffffff', emissiveIntensity: .15, emissiveMap: sponsorTexture(0, 2048, 256) }), 1, 10, 0); sign.rotation.y = Math.PI / 2;
    box(pits, metal, .5, 8.8, -15, .3, 1.8, .3); box(pits, metal, .5, 8.8, 15, .3, 1.8, .3);
    // Team transporters behind the garages.
    for (let i = 0; i < 9; i++) {
      const g = new THREE.Group(); g.position.set(-15, 0, -76 + i * 19); pits.add(g);
      box(g, std('#ececec', .35, .3), 0, 2.4, 0, 2.55, 3.9, 13.5);
      box(g, std(['#c43b25', '#1b2a6b', '#101727', '#f2c230', '#0f2a24'][i % 5], .3, .4), 0, 2.1, 8.2, 2.5, 3.2, 2.6);
      box(g, glass, 0, 2.9, 9.52, 2.3, 1.1, .05, false);
      for (const side of [-1, 1]) { const l = add(g, new THREE.PlaneGeometry(12, 3), new THREE.MeshStandardMaterial({ map: sponsorTexture(i + 1, 1024, 256), roughness: .45 }), side * 1.285, 2.6, 0, false); l.rotation.y = side * Math.PI / 2; }
      for (const z of [-5, -3.6, 7.6]) for (const x of [-1.1, 1.1]) { const w = add(g, new THREE.CylinderGeometry(.5, .5, .35, 14), std('#161718', .9), x, .5, z); w.rotation.z = Math.PI / 2; }
    }
    // Timing tower with lit crown.
    const tp = t.at(boxMid - 138, -30), tower = new THREE.Group(); tower.position.set(tp.x, 0, tp.z); tower.rotation.y = tp.heading; this.root.add(tower);
    box(tower, cmat, 0, 9, 0, 5, 18, 6); box(tower, glass, 0, 17, 0, 8, 4, 9); box(tower, dark, 0, 19.2, 0, 9, .4, 10);
    box(tower, std('#101213', .4, 0, { emissive: '#ff5a2e', emissiveIntensity: 1.6 }), 0, 19.6, 0, 9.1, .25, 10.1, false);
    const clock = add(tower, new THREE.PlaneGeometry(5, 1.2), new THREE.MeshStandardMaterial({ map: sponsorTexture(7, 512, 128), roughness: .5 }), 2.53, 13, 0); clock.rotation.y = Math.PI / 2;
    // Start gantry over the finish line, spanning barrier to barrier.
    const gp = t.at(t.finishS + 1.5), gantry = new THREE.Group(); gantry.position.set(gp.x, 0, gp.z); gantry.rotation.y = gp.heading; this.root.add(gantry);
    const halfSpan = t.barrierOffset + 1.6;
    for (const x of [-halfSpan, halfSpan]) { box(gantry, metal, x, 4.5, 0, .7, 9, .7); for (let y = 1; y < 9; y += 1.5) box(gantry, metal, x, y, 0, .8, .08, .8, false); }
    box(gantry, dark, 0, 8.4, 0, halfSpan * 2 + .8, 1.8, .9);
    for (const z of [.46, -.46]) { const s = add(gantry, new THREE.PlaneGeometry(halfSpan * 1.6, 1.4), new THREE.MeshStandardMaterial({ map: sponsorTexture(z > 0 ? 0 : 9, 2048, 256), roughness: .5 }), 0, 8.4, z, false); s.rotation.y = z > 0 ? 0 : Math.PI; }
    box(gantry, dark, 0, 6.9, -.3, 3.4, 1.2, .3);
    this.startLights = [];
    const glow = radialTexture([[0, 'rgba(255,90,50,1)'], [.3, 'rgba(255,60,30,.45)'], [1, 'rgba(255,40,10,0)']]);
    for (let i = 0; i < 5; i++) for (const y of [7.2, 6.65]) {
      const m = new THREE.MeshBasicMaterial({ color: '#2a1412', toneMapped: false });
      const l = add(gantry, new THREE.CircleGeometry(.2, 20), m, i * .62 - 1.24, y, -.47, false); l.rotation.y = Math.PI;
      if (y > 7) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 })); s.position.set(i * .62 - 1.24, 6.9, -.6); s.scale.setScalar(1.6); gantry.add(s); m.userData.glow = s; }
      this.startLights.push(l);
    }
  }

  buildStands() {
    const t = this.track, rng = this.rng, concrete = concreteMaps();
    this.stands = []; this.flashes = [];
    const person = mergeGeometries([new THREE.CapsuleGeometry(.19, .42, 2, 6).translate(0, .4, 0), new THREE.SphereGeometry(.12, 6, 5).translate(0, .95, 0)]);
    const flashPos = [], flashPhase = [];
    const L = t.length, mid = this.lane ? (this.lane.boxStart + this.lane.boxEnd) / 2 : t.finishS;
    const spots = this.theme.harbor ? [[165, 1, 110], [1330, 0, 80], [2240, 0, 90], [1030, 0, 70]]
      : [[wrap(mid - 45, L), 1, 110], [L * .45, 0, 80], [L * .76, 0, 90], [L * .35, 0, 70]];
    // A stand is a straight box, so test its real rotated footprint (roof
    // overhang included) against the track instead of sampling along the
    // curved centreline; slide, flip or shorten it until nothing overhangs.
    const placed = [], probe = new THREE.Object3D(), q = new THREE.Vector3();
    const fits = (s, side, length) => {
      const p = t.at(s, side * (t.barrierOffset + 8)); probe.position.set(p.x, 0, p.z); probe.rotation.set(0, side > 0 ? p.heading : p.heading + Math.PI, 0); probe.updateMatrix();
      for (let z = -length / 2 - 2; z <= length / 2 + 2; z += 3) for (const x of [-3.5, 0, 5, 10, 14.5, 17]) {
        q.set(x, 0, z).applyMatrix4(probe.matrix); if (!this.clearOf(q.x, q.z, 1)) return null;
        for (const o of placed) if (q.distanceTo(o.c) < o.r) return null;
      }
      return { p, rot: probe.rotation.y };
    };
    for (const [s0, prefer, length0] of spots) {
      let spot = null, s = s0, side = 1, length = length0;
      search: for (const len of [length0, length0 * .75, length0 * .55]) for (const ds of [0, 15, -15, 30, -30, 50, -50, 75, -75]) for (const cand of prefer ? [1, -1] : [-1, 1]) {
        const r = fits(s0 + ds, cand, len); if (r) { spot = r; s = s0 + ds; side = cand; length = len; break search; }
      }
      if (!spot) continue;
      const p = spot.p, g = new THREE.Group(); g.position.set(p.x, 0, p.z); g.rotation.y = spot.rot; this.root.add(g);
      placed.push({ c: new THREE.Vector3(p.x, 0, p.z), r: length / 2 + 20 });
      const rows = 12, shape = new THREE.Shape(); shape.moveTo(0, 0);
      for (let r = 0; r < rows; r++) { shape.lineTo(r * .9, r * .45 + .45); shape.lineTo(r * .9 + .9, r * .45 + .45); }
      shape.lineTo(rows * .9, 0); shape.lineTo(0, 0);
      const stepGeo = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false }); stepGeo.translate(0, 0, -length / 2);
      add(g, stepGeo, new THREE.MeshStandardMaterial({ ...repeatMaps(concrete, .1, .1), color: '#c9c6bb', roughness: .9 }));
      const roofMat = std('#e8e6df', .5, .3), steel = std('#8f9899', .35, .8);
      const roof = box(g, roofMat, rows * .45, rows * .45 + 5.2, 0, rows * .9 + 5, .3, length + 4); roof.rotation.z = -.07;
      for (let z = -length / 2; z <= length / 2; z += 12) { box(g, steel, rows * .9 + .5, (rows * .45 + 5.5) / 2, z, .35, rows * .45 + 5.5, .35); box(g, steel, rows * .45, rows * .45 + 4.6, z, rows * .9 + 4, .4, .25, false); }
      box(g, new THREE.MeshStandardMaterial({ ...repeatMaps(concrete, 2, 1), roughness: .9 }), rows * .9 + .2, (rows * .45 + 5) / 2, 0, .4, rows * .45 + 5, length);
      const fascia = add(g, new THREE.PlaneGeometry(length, 1.6), new THREE.MeshStandardMaterial({ map: sponsorTexture(this.stands.length + 2, 2048, 256), roughness: .5 }), -1.8, rows * .45 + 5.4, 0, false); fascia.rotation.y = -Math.PI / 2;
      // Crowd with per-instance bounce driven by excitement.
      const excite = { value: .3 };
      const crowdMat = new THREE.MeshStandardMaterial({ roughness: .85 });
      crowdMat.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = TIME; sh.uniforms.uExcite = excite;
        sh.vertexShader = 'uniform float uTime;uniform float uExcite;varying float vHead;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
          float id=float(gl_InstanceID);vHead=step(.8,position.y);
          float jump=max(0.,sin(uTime*(5.+mod(id,7.)*.6)+id*2.39));
          transformed.y+=jump*jump*.16*uExcite;transformed.x+=sin(uTime*1.3+id)*.03;
          if(position.y>.55&&abs(position.x)>.1)transformed.y+=uExcite*step(.6,fract(id*.137))*.35;`);
        sh.fragmentShader = 'varying float vHead;\n' + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb=mix(diffuseColor.rgb,vec3(.62,.46,.36),vHead);');
      };
      crowdMat.customProgramCacheKey = () => 'crowd';
      const seatsPerRow = Math.floor(length / .62), crowd = new THREE.InstancedMesh(person, crowdMat, rows * seatsPerRow); let n = 0; const d = this.dummy;
      const palette = ['#c43b25', '#f2f0e8', '#1b2a6b', '#f2c230', '#2a2e33', '#5ad1ff', '#8a5cff', '#e8483a', '#1f7a4a'];
      for (let r = 0; r < rows; r++) for (let i = 0; i < seatsPerRow; i++) {
        if (rng() < .18) continue;
        d.position.set(r * .9 + .45, r * .45 + .45, -length / 2 + (i + .5) * .62 + (rng() - .5) * .1); d.rotation.set(0, -Math.PI / 2 + (rng() - .5) * .5, 0); d.scale.setScalar(.92 + rng() * .16); d.updateMatrix();
        crowd.setMatrixAt(n, d.matrix); crowd.setColorAt(n, new THREE.Color(palette[Math.floor(rng() * palette.length)]).multiplyScalar(.6 + rng() * .5)); n++;
        if (rng() < .08) { const w = new THREE.Vector3(r * .9 + .45, r * .45 + 1.4, d.position.z).applyMatrix4(g.matrixWorld.compose(g.position, g.quaternion, g.scale)); flashPos.push(w.x, w.y, w.z); flashPhase.push(rng()); }
      }
      crowd.count = n; crowd.castShadow = false; crowd.receiveShadow = true; g.add(crowd);
      this.stands.push({ centre: new THREE.Vector3(p.x, 0, p.z), excite, s });
      if (this.stands.length === 1) this.buildScreen(g, rows, length);
    }
    const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.Float32BufferAttribute(flashPos, 3)); fg.setAttribute('phase', new THREE.Float32BufferAttribute(flashPhase, 1));
    const flashes = new THREE.Points(fg, new THREE.ShaderMaterial({
      uniforms: { uTime: TIME, uScale: { value: 600 } },
      vertexShader: `attribute float phase;uniform float uTime;uniform float uScale;varying float vA;void main(){vec4 mv=modelViewMatrix*vec4(position,1.);
        float f=fract(uTime*(.21+phase*.17)+phase*13.);vA=smoothstep(.985,.99,f)*(1.-smoothstep(.993,1.,f));gl_PointSize=uScale*.35/-mv.z;gl_Position=projectionMatrix*mv;}`,
      fragmentShader: `varying float vA;void main(){float r=length(gl_PointCoord-.5);if(vA<.01)discard;gl_FragColor=vec4(vec3(3.),vA*smoothstep(.5,0.,r));}`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    flashes.frustumCulled = false; this.live.add(flashes); this.flashPoints = flashes;
  }

  buildScreen(stand, rows, length) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 256; this.screenCanvas = c;
    const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; this.screenTexture = map;
    const frame = box(stand, std('#15191a', .5, .6), rows * .9 + 2, rows * .45 + 11.5, length / 2 - 12, .6, 7.4, 13.4);
    const screen = add(stand, new THREE.PlaneGeometry(12.6, 6.6), new THREE.MeshBasicMaterial({ map, toneMapped: true, color: new THREE.Color(1.6, 1.6, 1.6) }), rows * .9 + 1.68, rows * .45 + 11.5, length / 2 - 12, false);
    screen.rotation.y = -Math.PI / 2; box(stand, std('#8f9899', .35, .8), rows * .9 + 2.2, rows * .45 + 6.5, length / 2 - 12, .4, 6, .4);
    frame.castShadow = true;
  }

  drawScreen(car, time) {
    const c = this.screenCanvas; if (!c) return; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 512, 256); g.addColorStop(0, '#0b1520'); g.addColorStop(1, '#1a0e14'); x.fillStyle = g; x.fillRect(0, 0, 512, 256);
    x.fillStyle = '#e8483a'; x.fillRect(0, 0, 512, 34); x.fillStyle = '#fff'; x.font = 'italic 900 22px Arial'; x.textAlign = 'left'; x.fillText(`${this.track.name.toUpperCase()}  ·  LIVE`, 14, 25);
    x.fillStyle = (Math.floor(time * 2) % 2) ? '#ff3b30' : '#6d1b16'; x.beginPath(); x.arc(490, 17, 7, 0, Math.PI * 2); x.fill();
    const kmh = Math.round((car?.speed || 0) * 3.6);
    x.fillStyle = '#f4f1e8'; x.font = 'italic 900 118px Arial'; x.textAlign = 'right'; x.fillText(String(kmh), 330, 170);
    x.font = '700 26px Arial'; x.fillStyle = '#8fb3c9'; x.textAlign = 'left'; x.fillText('KM/H', 342, 168);
    x.font = 'italic 900 64px Arial'; x.fillStyle = '#f2c230'; x.fillText('G' + (car?.gear ?? 1), 400, 110);
    const rpm = clamp((car?.rpm || 0) / 8200, 0, 1); for (let i = 0; i < 24; i++) { x.fillStyle = i / 24 < rpm ? (i > 19 ? '#ff3b30' : i > 14 ? '#f2c230' : '#48d17a') : '#1f2a33'; x.fillRect(20 + i * 20, 200, 16, 22); }
    x.fillStyle = '#6c7f8c'; x.font = '600 16px Arial'; x.fillText(this.theme.banner, 20, 246);
    this.screenTexture.needsUpdate = true;
  }

  buildHarbor() {
    const d = this.dummy, rng = this.rng, concrete = concreteMaps();
    const quayMat = new THREE.MeshStandardMaterial({ ...repeatMaps(concrete, 6, 60), color: '#b8b3a6', roughness: .92 });
    box(this.root, quayMat, 740, -2.6, 0, 80, 5.3, 1600, false);
    add(this.root, new THREE.PlaneGeometry(.35, 1600), std('#e8c32a', .6), 778, .07, 0, false).rotation.x = -Math.PI / 2;
    const bollards = new THREE.InstancedMesh(new THREE.CylinderGeometry(.22, .28, .7, 10), std('#2a2d2e', .5, .6), 130);
    for (let i = 0; i < 130; i++) { d.position.set(778.8, .38, -780 + i * 12); d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1); d.updateMatrix(); bollards.setMatrixAt(i, d.matrix); }
    this.root.add(bollards);
    // Sea: dual scrolling normal maps, deep blue-green, strong fresnel reflections.
    const normal = waterNormal().clone(); normal.needsUpdate = true; normal.repeat.set(260, 260); normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
    const water = new THREE.MeshPhysicalMaterial({ color: '#15414c', roughness: .07, metalness: 0, ior: 1.33, normalMap: normal, normalScale: new THREE.Vector2(.55, .55), envMapIntensity: 1.3, specularIntensity: 1 });
    water.onBeforeCompile = (s) => {
      s.uniforms.uTime = TIME;
      s.fragmentShader = 'uniform float uTime;\n' + s.fragmentShader.replace('#include <normal_fragment_maps>', `
        vec3 n1=texture2D(normalMap,vNormalMapUv+vec2(uTime*.011,uTime*.006)).xyz*2.-1.;
        vec3 n2=texture2D(normalMap,vNormalMapUv*2.6+vec2(-uTime*.008,uTime*.013)).xyz*2.-1.;
        vec3 mapN=normalize(vec3((n1.xy+n2.xy*.7)*normalScale,max(n1.z*n2.z,.2)));
        normal=normalize(tbn*mapN);`);
    };
    const sea = add(this.root, new THREE.PlaneGeometry(8000, 8000), water, 4780, -1.4, 0, false); sea.rotation.x = -Math.PI / 2;
    // Breakwater and lighthouse.
    const rock = std('#6d6a62', .95);
    box(this.root, rock, 1080, -.8, -640, 620, 3.2, 14);
    const lh = new THREE.Group(); lh.position.set(1390, 0, -640); this.root.add(lh);
    for (let i = 0; i < 6; i++) add(lh, new THREE.CylinderGeometry(2.3 - i * .18, 2.45 - i * .18, 3.4, 20), std(i % 2 ? '#c2322a' : '#f2efe6', .6), 0, 1.7 + i * 3.4);
    add(lh, new THREE.CylinderGeometry(1.5, 1.5, 2.2, 16), new THREE.MeshPhysicalMaterial({ color: '#fff6d8', emissive: '#fff1c0', emissiveIntensity: 3, roughness: .1 }), 0, 22.5);
    add(lh, new THREE.ConeGeometry(1.9, 1.6, 16), std('#2b2f30', .4, .6), 0, 24.4);
    const beamMat = new THREE.MeshBasicMaterial({ map: radialTexture([[0, 'rgba(255,245,210,.55)'], [1, 'rgba(255,245,210,0)']]), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const beam = new THREE.Group(); beam.position.set(1390, 22.5, -640); this.live.add(beam);
    for (const dir of [1, -1]) { const b = new THREE.Mesh(new THREE.ConeGeometry(9, 140, 20, 1, true), beamMat); b.rotation.z = dir * Math.PI / 2; b.position.x = dir * 70; beam.add(b); }
    this.animators.push((t) => { beam.rotation.y = t * .6; });

    // Container ship at the berth.
    const ship = new THREE.Group(); ship.position.set(812, -1.4, 20); this.root.add(ship);
    const hull = new THREE.Shape(); hull.moveTo(-16, -110); hull.lineTo(16, -110); hull.lineTo(16, 80); hull.quadraticCurveTo(15, 110, 0, 122); hull.quadraticCurveTo(-15, 110, -16, 80); hull.lineTo(-16, -110);
    const hullGeo = new THREE.ExtrudeGeometry(hull, { depth: 11, bevelEnabled: false }); hullGeo.rotateX(-Math.PI / 2);
    add(ship, hullGeo, std('#1c3040', .55, .3)).position.y = -1;
    const boot = new THREE.ExtrudeGeometry(hull, { depth: 1.6, bevelEnabled: false }); boot.rotateX(-Math.PI / 2); boot.scale(1.004, 1, 1.004);
    add(ship, boot, std('#8e2a22', .7), 0, -1.05, 0, false);
    const superMat = new THREE.MeshStandardMaterial({ ...facadeMaps(3, 2), roughness: .6 }); superMat.emissive.set('#ffffff'); superMat.emissiveIntensity = .5;
    box(ship, superMat, 0, 21, -96, 28, 20, 16); box(ship, std('#f2efe6', .5), 0, 31.5, -96, 34, 1, 10);
    add(ship, new THREE.CylinderGeometry(2.6, 3, 10, 16), std('#c43b25', .5), 0, 36, -103);
    const cmap = containerMaps(), cmat = new THREE.MeshStandardMaterial({ ...cmap, roughness: .6, metalness: .3 });
    const palette = ['#b43a2a', '#1f5f9a', '#c9a227', '#2f6b3a', '#d7d4cc', '#7a2f5c', '#3d4a52', '#d86a26'];
    const containers = new THREE.InstancedMesh(new THREE.BoxGeometry(2.44, 2.6, 12.2), cmat, 1300); containers.count = 0;
    const put = (x, y, z, rot = 0) => { d.position.set(x, y, z); d.rotation.set(0, rot, 0); d.scale.set(1, 1, 1); d.updateMatrix(); containers.setMatrixAt(containers.count, d.matrix); containers.setColorAt(containers.count++, new THREE.Color(palette[Math.floor(rng() * palette.length)]).multiplyScalar(.75 + rng() * .35)); };
    for (let bay = 0; bay < 12; bay++) for (let col = 0; col < 12; col++) { const tiers = 2 + Math.floor(rng() * 4); for (let k = 0; k < tiers; k++) put(812 - 13.4 + col * 2.44, 10.6 + 1.3 + k * 2.6 - 1.4, 20 - 82 + bay * 13.2 + 6); }
    // Container yard between the circuit and the quay.
    for (let row = 0; row < 11; row++) for (let i = 0; i < 40; i++) {
      const x = 560 + row * 12, z = -560 + i * 30; if (!this.clearOf(x, z, 10)) continue;
      const tiers = 1 + Math.floor(rng() * 4); for (let k = 0; k < tiers; k++) if (containers.count < 1300) put(x, 1.3 + k * 2.6, z, Math.PI / 2 * 0 + 0);
    }
    containers.castShadow = true; containers.receiveShadow = true; this.root.add(containers);
    // Ship-to-shore cranes with moving trolleys and aviation lights.
    for (let i = 0; i < 4; i++) this.buildCrane(750, -60 + i * 52, i);
    // Warehouses and a factory with smoking stacks.
    const shed = new THREE.MeshStandardMaterial({ ...repeatMaps(cmap, 8, 3), color: '#a7b1b2', roughness: .6, metalness: .4 });
    for (const [x, z, w, dd] of [[640, 470, 70, 40], [640, 540, 70, 40], [700, 640, 50, 60], [620, -640, 80, 40], [700, -700, 60, 50]]) {
      if (!this.clearOf(x, z, 30)) continue; box(this.root, shed, x, 7, z, w, 14, dd); box(this.root, std('#4b5456', .6, .5), x, 14.3, z, w + 1, .6, dd + 1);
    }
    const stacks = [[560, 420], [578, 420]].filter(([x, z]) => this.clearOf(x, z, 12));
    for (const [x, z] of stacks) for (let k = 0; k < 7; k++) add(this.root, new THREE.CylinderGeometry(2.2 - k * .1, 2.4 - k * .1, 7, 16), std(k % 2 ? '#c2322a' : '#ecebe4', .6), x, 3.5 + k * 7, z);
    if (stacks.length) box(this.root, std('#8d8f88', .7, .2), 569, 9, 440, 50, 18, 30);
    this.smoke = [];
    const smokeMat = new THREE.SpriteMaterial({ map: smokeTexture(), color: '#d9d6cf', transparent: true, depthWrite: false, opacity: .5, fog: true });
    for (const [x, z] of stacks) for (let i = 0; i < 26; i++) { const s = new THREE.Sprite(smokeMat.clone()); s.userData = { x, z, age: i / 26 * 14, life: 14 }; this.live.add(s); this.smoke.push(s); }

    // Moving boats with wakes.
    const wakeMat = new THREE.MeshBasicMaterial({ map: radialTexture([[0, 'rgba(255,255,255,.7)'], [.5, 'rgba(230,240,240,.25)'], [1, 'rgba(255,255,255,0)']]), transparent: true, depthWrite: false });
    const boat = (len, beam, hullColor, cabin) => {
      const g = new THREE.Group(), h = new THREE.Shape(); h.moveTo(-beam / 2, -len / 2); h.lineTo(beam / 2, -len / 2); h.lineTo(beam / 2, len * .2); h.quadraticCurveTo(beam / 2, len / 2, 0, len / 2); h.quadraticCurveTo(-beam / 2, len / 2, -beam / 2, len * .2); h.lineTo(-beam / 2, -len / 2);
      const geo = new THREE.ExtrudeGeometry(h, { depth: beam * .45, bevelEnabled: false }); geo.rotateX(-Math.PI / 2); geo.translate(0, -beam * .12, 0);
      add(g, geo, std(hullColor, .5, .2)); if (cabin) cabin(g);
      const wake = new THREE.Mesh(new THREE.PlaneGeometry(beam * 3, len * 4), wakeMat); wake.rotation.x = -Math.PI / 2; wake.position.set(0, .05, -len * 2); g.add(wake);
      this.live.add(g); return g;
    };
    const white = std('#f1efe8', .45);
    const tug = boat(24, 9, '#c43b25', (g) => { box(g, white, 0, 3, -2, 6, 3.4, 8); box(g, std('#1d2224', .3), 0, 4.2, 1.8, 5.8, 1, .1, false); add(g, new THREE.CylinderGeometry(.7, .7, 4), std('#f2c230', .5), 0, 6, -4); });
    const ferry = boat(70, 16, '#f1efe8', (g) => { box(g, white, 0, 5, -2, 14, 5, 48); box(g, new THREE.MeshStandardMaterial({ ...facadeMaps(9, 2), roughness: .5 }), 0, 9.5, 4, 12, 4, 26); add(g, new THREE.CylinderGeometry(1.6, 1.8, 5), std('#1f5f9a', .5), 0, 13, -12); });
    const sails = [];
    for (let i = 0; i < 6; i++) sails.push(boat(10, 3.4, i % 2 ? '#f1efe8' : '#1b2a6b', (g) => {
      add(g, new THREE.CylinderGeometry(.08, .1, 14), std('#d0d4d6', .3, .8), 0, 7, .8);
      const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute([0, 1.2, .9, 0, 13.5, .8, 0, 1.2, -4.2], 3)); sg.computeVertexNormals();
      add(g, sg, new THREE.MeshStandardMaterial({ color: '#f7f5ee', roughness: .8, side: THREE.DoubleSide }));
    }));
    const speed = boat(9, 3, '#101213', (g) => box(g, new THREE.MeshPhysicalMaterial({ color: '#223', roughness: .05, metalness: .5 }), 0, 1.3, 0, 2.4, .8, 2.4));
    this.animators.push((t) => {
      const bob = (g, k, ph) => { g.position.y = -1.2 + Math.sin(t * 1.3 + ph) * .18 * k; g.rotation.z = Math.sin(t * 1.1 + ph) * .04 * k; g.rotation.x = Math.sin(t * .9 + ph * 1.7) * .02 * k; };
      let a = t * .012; tug.position.set(1080 + Math.cos(a) * 260, 0, -120 + Math.sin(a) * 380); tug.rotation.y = Math.atan2(-Math.sin(a) * 260, Math.cos(a) * 380); bob(tug, 1, 0);
      const fz = ((t * 7) % 3600) - 1800, dir = Math.floor(t * 7 / 3600) % 2 ? -1 : 1; ferry.position.set(1750, 0, dir * fz); ferry.rotation.y = dir > 0 ? 0 : Math.PI; bob(ferry, .5, 2);
      sails.forEach((g, i) => { const b = t * (.006 + i * .0009) + i * 1.1, r = 300 + i * 70; g.position.set(1500 + Math.cos(b) * r, 0, 350 + Math.sin(b) * r * .6); g.rotation.y = Math.atan2(-Math.sin(b) * r, Math.cos(b) * r * .6); bob(g, 1.6, i); g.rotation.z += .12; });
      a = t * .05; speed.position.set(1200 + Math.cos(a) * 180, 0, 500 + Math.sin(a * 2) * 120); speed.rotation.y = Math.atan2(-Math.sin(a) * 180, Math.cos(a * 2) * 240); bob(speed, .6, 5);
    });
    // Channel buoys.
    const buoys = [];
    for (let i = 0; i < 12; i++) { const b = add(this.live, new THREE.CylinderGeometry(.5, .8, 2.4, 10), std(i % 2 ? '#1f8a3a' : '#c2322a', .5)); b.position.set(900 + Math.floor(i / 2) * 110, -.6, -420 + (i % 2) * 90); buoys.push(b); }
    this.animators.push((t) => buoys.forEach((b, i) => { b.position.y = -.7 + Math.sin(t * 1.6 + i) * .2; b.rotation.z = Math.sin(t * 1.2 + i * 2) * .1; }));
    // Straddle carriers shuttling through the yard.
    const carrierMat = std('#e9e5d8', .5, .4), carriers = [];
    for (let i = 0; i < 3; i++) {
      const g = new THREE.Group(); for (const x of [-2.3, 2.3]) for (const z of [-4, 4]) box(g, carrierMat, x, 6, z, .5, 12, .5);
      box(g, carrierMat, 0, 12.2, 0, 5.2, .7, 9); box(g, std('#1d2224', .3), 2.3, 11, 4.3, 1.2, 1.4, 1.2); box(g, std('#c43b25', .5), 0, 4, 0, 2.44, 2.6, 12.2);
      this.live.add(g); carriers.push(g);
    }
    this.animators.push((t) => carriers.forEach((g, i) => { g.position.set(566 + i * 36, 0, Math.sin(t * .03 + i * 2) * 420 + 20); }));
  }

  buildCrane(x, z, index) {
    const g = new THREE.Group(); g.position.set(x, 0, z); this.root.add(g);
    const main = std(index % 2 ? '#2b5f9a' : '#c2382a', .5, .5), white = std('#ecebe4', .5, .4);
    for (const lx of [-9, 9]) for (const lz of [-8, 8]) { box(g, main, lx, 19, lz, 1.3, 38, 1.3); box(g, std('#2c3133', .6, .6), lx, .6, lz, 2.4, 1.2, 3); }
    for (const lz of [-8, 8]) box(g, main, 0, 38, lz, 19.3, 1.6, 1.4);
    for (const lx of [-9, 9]) box(g, main, lx, 20, 0, 1, 1, 17);
    box(g, white, 40, 41, 0, 150, 2.6, 3.4);
    box(g, main, -24, 44, 0, 14, 6, 10);
    for (const lz of [-1.5, 1.5]) { const a = box(g, main, -3, 50, lz, .9, 20, .9); a.rotation.z = -.25; const b = box(g, main, 5, 50, lz, .9, 20, .9); b.rotation.z = .25; }
    const tie1 = box(g, std('#3a3f41', .5, .8), 57, 50.5, 0, 106, .18, .18, false); tie1.rotation.z = -Math.atan2(17, 110) * .95;
    const tie2 = box(g, std('#3a3f41', .5, .8), -14, 50.5, 0, 30, .18, .18, false); tie2.rotation.z = Math.atan2(17, 24);
    // Moving parts live outside the frozen root.
    const trolley = new THREE.Group(); trolley.position.set(x, 38.5, z); this.live.add(trolley);
    box(trolley, std('#f2c230', .5, .4), 0, 0, 0, 6, 2, 4.2);
    const cable = box(trolley, std('#202425', .5, .8), 0, -1, 0, .12, 1, .12, false);
    const spreader = new THREE.Group(); trolley.add(spreader);
    box(spreader, std('#f2c230', .5, .4), 0, 0, 0, 2.6, .7, 12.4); const load = box(spreader, std(['#1f5f9a', '#b43a2a', '#2f6b3a', '#c9a227'][index], .6, .3), 0, -1.7, 0, 2.44, 2.6, 12.2);
    const lightMat = new THREE.MeshBasicMaterial({ color: '#ff2a1a', toneMapped: false });
    const beacons = [[x - 3, 60.5, z], [x + 115, 43, z], [x - 31, 47.5, z]].map(([bx, by, bz]) => add(this.live, new THREE.SphereGeometry(.45, 8, 6), lightMat, bx, by, bz, false));
    const phase = index * 1.7;
    this.animators.push((t) => {
      const cycle = (t * .045 + phase) % 1, travel = Math.sin(cycle * Math.PI * 2) * .5 + .5;
      trolley.position.x = x + 8 + travel * 88;
      const drop = Math.max(0, Math.sin(cycle * Math.PI * 4)) * 18 + 6;
      spreader.position.y = -drop; cable.scale.y = drop; cable.position.y = -drop / 2;
      load.visible = cycle > .25 && cycle < .75;
      const on = Math.sin(t * 3.4 + phase) > .55; lightMat.color.set(on ? '#ff2a1a' : '#3a0a06'); beacons.forEach((b) => (b.visible = true));
    });
  }

  buildCity() {
    const d = this.dummy, rng = this.rng;
    // Facade shader: world-scale UVs from the instance scale so windows keep size.
    const facade = (style) => {
      const maps = facadeMaps(40 + style, style), m = new THREE.MeshStandardMaterial({ ...maps, emissive: '#ffffff', emissiveIntensity: .55, roughness: .7, metalness: .15 });
      m.onBeforeCompile = (s) => {
        s.vertexShader = 'varying vec2 vFac;varying float vRoof;\n' + s.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
          vec3 sc=vec3(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz),length(instanceMatrix[2].xyz));vec3 lp=position*sc;
          vFac=(abs(normal.x)>.5?vec2(lp.z,lp.y):vec2(lp.x,lp.y))/vec2(26.,52.)+vec2(sc.x*.013,0.);vRoof=step(.5,normal.y);`);
        s.fragmentShader = 'varying vec2 vFac;varying float vRoof;\n' + s.fragmentShader
          .replace('#include <map_fragment>', 'diffuseColor*=mix(texture2D(map,vFac),vec4(.24,.25,.26,1.),vRoof);')
          .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance*=texture2D(emissiveMap,vFac).rgb*(1.-vRoof);');
      };
      m.customProgramCacheKey = () => 'facade';
      return m;
    };
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, .5, 0);
    const meshes = [0, 1, 2, 3].map((s) => { const m = new THREE.InstancedMesh(geo, facade(s), 160); m.count = 0; m.receiveShadow = true; this.root.add(m); return m; });
    const roofs = new THREE.InstancedMesh(geo, std('#5d6365', .7, .4), 500); roofs.count = 0; this.root.add(roofs);
    const building = (x, z, w, dd, h) => {
      if (!this.clearOf(x, z, Math.hypot(w, dd) / 2 + 25)) return;
      const m = meshes[Math.floor(rng() * 4)]; if (m.count >= 160) return;
      d.position.set(x, 0, z); d.rotation.set(0, (rng() - .5) * .1, 0); d.scale.set(w, h, dd); d.updateMatrix(); m.setMatrixAt(m.count++, d.matrix);
      for (let k = 0; k < 2 && roofs.count < 500; k++) { d.position.set(x + (rng() - .5) * w * .5, h, z + (rng() - .5) * dd * .5); d.scale.set(3 + rng() * 5, 2 + rng() * 3, 3 + rng() * 5); d.rotation.set(0, 0, 0); d.updateMatrix(); roofs.setMatrixAt(roofs.count++, d.matrix); }
    };
    if (this.theme.city === 'village') {
      // Stone villages in the countryside, well clear of the circuit.
      const b = this.bounds;
      for (let v = 0; v < 6; v++) {
        const a = v / 6 * Math.PI * 2 + rng() * .6, r = b.r + 300 + rng() * 500, vx = b.cx + Math.cos(a) * r, vz = b.cz + Math.sin(a) * r;
        for (let i = 0; i < 14; i++) building(vx + (rng() - .5) * 170, vz + (rng() - .5) * 170, 10 + rng() * 10, 10 + rng() * 12, 6 + rng() * 9);
        building(vx, vz, 7, 7, 26 + rng() * 8);
      }
    }
    if (this.theme.city !== 'metro') return;
    for (let i = 0; i < 150; i++) { const x = -760 - rng() * 800, z = (rng() - .5) * 1600, core = Math.exp(-((x + 1050) ** 2 + z * z) / 300000); building(x, z, 20 + rng() * 26, 20 + rng() * 26, 18 + rng() * 40 + core * 150 * rng()); }
    for (let i = 0; i < 90; i++) { const x = -650 + rng() * 1200, z = (rng() < .5 ? 1 : -1) * (520 + rng() * 520); building(x, z, 18 + rng() * 22, 18 + rng() * 22, 12 + rng() * 36); }
  }

  // Horizon ranges layered into the haze. The harbor keeps its western arc; the
  // other circuits get a full ring around the layout. Mountains carry snow above
  // a height line (vertex colours), mesas get flat tops.
  buildHills() {
    const h = this.theme.hills, rng = this.rng, b = this.bounds, arc = h.arc ?? [0, 2];
    const cx = this.theme.harbor ? 0 : b.cx, cz = this.theme.harbor ? 0 : b.cz, base = this.theme.harbor ? 2300 : Math.max(2300, b.r + 1400);
    const snow = new THREE.Color('#e6ecf4'), tmp = new THREE.Color();
    for (let layer = 0; layer < 3; layer++) {
      const v = [], col = [], idx = [], radius = base + layer * 520, seg = h.jagged ? 360 : 180, rows = h.snow ? 6 : 1, c0 = new THREE.Color(h.colors[layer]);
      for (let i = 0; i <= seg; i++) {
        const a = Math.PI * arc[0] + i / seg * Math.PI * arc[1], x = cx + Math.cos(a) * radius, z = cz + Math.sin(a) * radius;
        let y = 120 + Math.sin(a * 5 + layer) * 70 + Math.sin(a * 13 + layer * 2) * 30 + rng() * 22 + layer * 60;
        if (h.jagged) y += Math.abs(Math.sin(a * 23 + layer * 3)) * 140 + Math.abs(Math.sin(a * 57 + layer)) * 60;
        if (h.mesa) y = Math.sin(a * 7 + layer * 1.3) > -.2 ? Math.min(y, 150 + layer * 40) : y * .3;
        y *= h.height;
        for (let r = 0; r <= rows; r++) {
          const k = r / rows, yy = -5 + (y + 5) * k; v.push(x, yy, z);
          tmp.copy(c0).lerp(snow, h.snow ? smooth01((yy - 260) / 120) : 0); col.push(tmp.r, tmp.g, tmp.b);
        }
        if (i < seg) for (let r = 0; r < rows; r++) { const q = i * (rows + 1) + r, n = q + rows + 1; idx.push(q, q + 1, n, q + 1, n + 1, n); }
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
      add(this.root, g, std('#ffffff', 1, 0, { side: THREE.DoubleSide, vertexColors: true }), 0, 0, 0, false);
    }
  }

  // Braking boards off the harbor: the entry of each corner that follows at
  // least 220 m of near-straight.
  brakingZones() {
    const t = this.track, out = []; let straight = 0;
    for (let s = 0; s < t.length * 2; s += 5) {
      const k = Math.abs(t.at(s % t.length).curvature);
      if (k < .004) straight += 5;
      else if (k > .012) { if (straight >= 220 && s >= t.length) out.push(s - t.length); straight = 0; }
    }
    return out.slice(0, 8);
  }

  // Desert: boulders and dry scrub scattered around the layout.
  buildDesert() {
    const d = this.dummy, rng = this.rng, b = this.bounds, span = b.r * 2 + 1600;
    const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 1), std('#ffffff', .95), 900);
    const scrub = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), std('#ffffff', 1), 1600); rocks.count = scrub.count = 0;
    const cap = new Map([[rocks, 900], [scrub, 1600]]), c = new THREE.Color();
    for (let i = 0; i < 14000; i++) {
      const x = b.cx + (rng() - .5) * span, z = b.cz + (rng() - .5) * span; if (!this.clearOf(x, z, 6)) continue;
      const m = rng() < .4 ? rocks : scrub; if (m.count >= cap.get(m)) continue;
      const sc = m === rocks ? (rng() < .08 ? 4 + rng() * 9 : .6 + rng() * 2.4) : .5 + rng() * 1.1;
      d.position.set(x, sc * .25, z); d.rotation.set(rng() * 3, rng() * 6.28, rng() * 3); d.scale.set(sc * (.8 + rng() * .6), sc * (.5 + rng() * .5), sc * (.8 + rng() * .6)); d.updateMatrix();
      m.setMatrixAt(m.count, d.matrix); m.setColorAt(m.count++, m === rocks ? c.setHSL(.06 + rng() * .03, .35, .38 + rng() * .18) : c.setHSL(.14 + rng() * .05, .3, .3 + rng() * .12));
    }
    rocks.castShadow = scrub.castShadow = rocks.receiveShadow = scrub.receiveShadow = true; this.root.add(rocks, scrub);
  }

  buildStars() {
    const rng = random(77), n = 2400, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const a = rng() * Math.PI * 2, y = .06 + rng() * .94, r = Math.sqrt(1 - y * y); pos.set([Math.cos(a) * r * 8000, y * 8000, Math.sin(a) * r * 8000], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: '#dfe8ff', size: 1.8, sizeAttenuation: false, fog: false, transparent: true, opacity: .85 * this.dark, depthWrite: false }));
    this.stars.visible = this.dark > .01; this.stars.frustumCulled = false; this.live.add(this.stars);
  }

  dispose() {
    for (const o of [this.root, this.live, this.sky, this.sun, this.sun.target, this.hemi, this.clouds, this.headlight, this.headlight.target]) if (o) o.parent?.remove(o);
    const seen = new Set();
    for (const g of [this.root, this.live, this.sky, this.clouds]) g?.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material ?? [])) { if (seen.has(m)) continue; seen.add(m); for (const v of Object.values(m)) if (v?.isTexture) v.dispose(); m.dispose(); }
      if (o.isInstancedMesh) o.dispose();
    });
    this.envTarget?.dispose(); this.pmrem.dispose();
    if (this.scene.environment === this.envTarget?.texture) this.scene.environment = null;
  }

  buildNature() {
    const t = this.track, d = this.dummy, rng = this.rng;
    // Palms: bent trunk plus drooping fronds, one instanced mesh with two materials.
    const trunkGeo = new THREE.CylinderGeometry(.18, .32, 11, 7, 6); trunkGeo.translate(0, 5.5, 0);
    const tp = trunkGeo.attributes.position; for (let i = 0; i < tp.count; i++) { const y = tp.getY(i); tp.setX(i, tp.getX(i) + (y / 11) ** 2 * 1.4); }
    trunkGeo.computeVertexNormals();
    const fronds = [];
    for (let i = 0; i < 9; i++) {
      const f = new THREE.PlaneGeometry(5, 2.2, 4, 1); f.translate(2.5, 0, 0);
      const fp = f.attributes.position; for (let k = 0; k < fp.count; k++) { const x = fp.getX(k); fp.setY(k, fp.getY(k) * .2 - (x / 5) ** 2 * 1.8); fp.setZ(k, fp.getY(k) * 0 + (fp.getZ(k))); }
      f.rotateX(Math.PI / 2 * .9); f.rotateZ(.25); f.rotateY(i / 9 * Math.PI * 2 + rng() * .3); f.translate(1.4, 11, 0); f.computeVertexNormals(); fronds.push(f);
    }
    const palmGeo = mergeGeometries([trunkGeo.toNonIndexed(), mergeGeometries(fronds.map((f) => f.toNonIndexed()))], true);
    const trunkMat = sway(std('#7b6a4f', .95), .0016, 'palm-trunk'), frondMat = sway(new THREE.MeshStandardMaterial({ map: foliageTexture(7, true), alphaTest: .4, side: THREE.DoubleSide, roughness: .8 }), .0018, 'palm-frond');
    const th = this.theme, palmMax = th.palms ?? 420, treeMax = th.trees ?? 1400;
    const palms = new THREE.InstancedMesh(palmGeo, [trunkMat, frondMat], 420); palms.count = 0;
    const plant = (mesh, x, z, sc, max) => { if (mesh.count >= max) return; d.position.set(x, -.05, z); d.rotation.set(0, rng() * 6.28, 0); d.scale.setScalar(sc); d.updateMatrix(); mesh.setMatrixAt(mesh.count++, d.matrix); };
    for (let i = 0; i < 1600 && palms.count < palmMax; i++) {
      const s = rng() * t.length, p = t.at(s, (rng() < .5 ? -1 : 1) * (t.barrierOffset + 10 + rng() * 30)); if (this.clearOf(p.x, p.z, 6) && (!th.harbor || p.x < 700)) plant(palms, p.x, p.z, .8 + rng() * .5, palmMax);
    }
    if (th.harbor) for (let z = -760; z < 760; z += 26) if (this.clearOf(706, z, 6)) plant(palms, 706 + (rng() - .5) * 3, z, 1 + rng() * .2, 420);
    palms.castShadow = true; palms.receiveShadow = true; this.root.add(palms);
    // Broadleaf trees: crossed cards with sway.
    const treeMat = sway(new THREE.MeshStandardMaterial({ map: foliageTexture(57), alphaTest: .45, side: THREE.DoubleSide, roughness: .9, color: '#e8ecd6' }), .0009, 'tree');
    const card = new THREE.PlaneGeometry(12, 12); card.translate(0, 6, 0); const treeGeo = mergeGeometries([card, card.clone().rotateY(Math.PI / 2)]);
    const trees = new THREE.InstancedMesh(treeGeo, treeMat, Math.max(1, treeMax)); trees.count = 0;
    const bb = this.bounds, spanX = th.harbor ? 1950 : bb.x1 - bb.x0 + 1200, spanZ = th.harbor ? 2000 : bb.z1 - bb.z0 + 1200;
    for (let i = 0; i < treeMax * 4 && trees.count < treeMax; i++) {
      const x = th.harbor ? -1400 + rng() * spanX : bb.x0 - 600 + rng() * spanX, z = th.harbor ? (rng() - .5) * spanZ : bb.z0 - 600 + rng() * spanZ;
      if (th.harbor && x > 540 && rng() < .9) continue; if (!this.clearOf(x, z, 8)) continue;
      if (Math.abs(t.nearest(x, z).lateral) < 45 && rng() < .6) continue;
      plant(trees, x, z, .6 + rng() * .9, treeMax); trees.setColorAt(trees.count - 1, new THREE.Color().setHSL(.18 + rng() * .06, .15, .72 + rng() * .25));
    }
    trees.castShadow = true; trees.receiveShadow = true; this.root.add(trees);
    if (th.pines) this.buildPines(th.pines);
    if (th.blades === false) { this.buildFlags(); return; }
    // Verge grass blades.
    const blade = new THREE.BufferGeometry(); blade.setAttribute('position', new THREE.Float32BufferAttribute([-.04, 0, 0, .04, 0, 0, .01, .5, .03, -.03, 0, .02, .03, 0, -.02, -.02, .42, -.04], 3)); blade.computeVertexNormals();
    const blades = new THREE.InstancedMesh(blade, sway(std('#8f9660', 1, 0, { side: THREE.DoubleSide }), .35, 'grass'), 22000);
    for (let i = 0; i < 22000; i++) {
      const side = rng() < .5 ? -1 : 1, lat = rng() < .35 ? t.halfWidth + t.curbWidth + t.runoffWidth - 1 + rng() * 1.8 : t.barrierOffset + 2.4 + rng() * 26;
      const p = t.at(rng() * t.length, side * lat); d.position.set(p.x, -.03, p.z); d.rotation.set(0, rng() * 6.28, 0); d.scale.setScalar(.6 + rng() * 1.1); d.updateMatrix();
      blades.setMatrixAt(i, d.matrix); blades.setColorAt(i, new THREE.Color().setHSL(.15 + rng() * .06, .25 + rng() * .15, .28 + rng() * .16));
    }
    if (th.ground === 'alpine') blades.material.color.set('#6f8468');
    this.root.add(blades);
    this.buildFlags();
  }

  // Alpine forest: an instanced trunk plus three stacked cones per pine.
  buildPines(max) {
    const t = this.track, d = this.dummy, rng = this.rng, bb = this.bounds;
    const cone = (r, h, y) => new THREE.ConeGeometry(r, h, 8).translate(0, y, 0).toNonIndexed();
    const needles = mergeGeometries([cone(3.2, 6, 5), cone(2.5, 5, 8), cone(1.7, 4, 10.6)]);
    const trunk = new THREE.CylinderGeometry(.22, .36, 4, 6).translate(0, 2, 0);
    const pines = new THREE.InstancedMesh(needles, sway(std('#ffffff', .95), .0007, 'pine'), max), trunks = new THREE.InstancedMesh(trunk, std('#4a3a2c', 1), max);
    pines.count = trunks.count = 0; const c = new THREE.Color();
    for (let i = 0; i < max * 5 && pines.count < max; i++) {
      const x = bb.x0 - 700 + rng() * (bb.x1 - bb.x0 + 1400), z = bb.z0 - 700 + rng() * (bb.z1 - bb.z0 + 1400);
      if (!this.clearOf(x, z, 7)) continue; if (Math.abs(t.nearest(x, z).lateral) < 40 && rng() < .7) continue;
      d.position.set(x, -.05, z); d.rotation.set(0, rng() * 6.28, 0); const sc = .8 + rng() * 1.3; d.scale.set(sc, sc * (.9 + rng() * .4), sc); d.updateMatrix();
      pines.setMatrixAt(pines.count, d.matrix); trunks.setMatrixAt(trunks.count++, d.matrix);
      pines.setColorAt(pines.count++, c.setHSL(.36 + rng() * .06, .35, .16 + rng() * .1));
    }
    pines.castShadow = trunks.castShadow = true; pines.receiveShadow = true; this.root.add(pines, trunks);
  }

  buildFlags() {
    const t = this.track;
    // Flag row along the paddock.
    const flagGeo = new THREE.PlaneGeometry(1.4, 3.2, 14, 4); flagGeo.translate(.7, 0, 0);
    for (let i = 0; i < 14; i++) {
      const p = t.at(t.finishS + 40 + i * 12, -(t.barrierOffset + 4.5)); if (!this.clearOf(p.x, p.z, -1)) continue;
      add(this.root, new THREE.CylinderGeometry(.05, .06, 9, 8), std('#cfd3d4', .3, .8), p.x, 4.5, p.z);
      const f = add(this.live, flagGeo, sway(new THREE.MeshStandardMaterial({ map: sponsorTexture(i, 512, 128), side: THREE.DoubleSide, roughness: .8 }), .09, 'flag', 'flag'), p.x, 7.2, p.z); f.rotation.set(0, p.heading + .8, Math.PI / 2);
    }
  }

  buildSkyLife() {
    // Gull flocks: instanced with wing flap in the vertex shader.
    const wing = new THREE.BufferGeometry();
    wing.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, .35, 0, 0, -.25, -.9, .05, 0, 0, 0, .35, .9, .05, 0, 0, 0, -.25, 0, 0, .45, 0, .08, -.3, 0, -.08, -.3], 3)); wing.computeVertexNormals();
    const gullMat = new THREE.MeshStandardMaterial({ color: '#f3f3ef', roughness: .8, side: THREE.DoubleSide });
    gullMat.onBeforeCompile = (s) => { s.uniforms.uTime = TIME; s.vertexShader = 'uniform float uTime;\n' + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y+=abs(position.x)*sin(uTime*9.+float(gl_InstanceID)*1.7)*.7;'); };
    gullMat.customProgramCacheKey = () => 'gull';
    this.gulls = new THREE.InstancedMesh(wing, gullMat, 48); this.gulls.frustumCulled = false; this.live.add(this.gulls);
    this.gullSeeds = Array.from({ length: 48 }, (_, i) => ({ flock: i % 4, r: 30 + this.rng() * 40, ph: this.rng() * 6.28, h: 30 + this.rng() * 25, sp: .1 + this.rng() * .06 }));
    // TV helicopter tracking the focused car.
    const heli = new THREE.Group(), hm = std('#1b2a6b', .35, .5), glass = new THREE.MeshPhysicalMaterial({ color: '#0d1a20', roughness: .05, metalness: .6 });
    add(heli, new THREE.SphereGeometry(1.3, 16, 12).scale(1, .9, 1.7), hm); add(heli, new THREE.SphereGeometry(1.05, 14, 10).scale(1, .8, 1).translate(0, .1, 1.3), glass);
    add(heli, new THREE.CylinderGeometry(.18, .32, 5.2, 8).rotateX(Math.PI / 2).translate(0, .3, -3.6), hm); add(heli, new THREE.BoxGeometry(.1, 1.2, .8).translate(0, .8, -6), hm);
    for (const x of [-.8, .8]) add(heli, new THREE.BoxGeometry(.08, .08, 3).translate(x, -1.35, 0), std('#333', .5, .7));
    this.rotor = new THREE.Group(); this.rotor.position.y = 1.35; heli.add(this.rotor);
    for (let i = 0; i < 4; i++) add(this.rotor, new THREE.BoxGeometry(5.2, .04, .25).translate(2.6, 0, 0).rotateY(i * Math.PI / 2), std('#222', .6), 0, 0, 0, false);
    add(this.rotor, new THREE.CircleGeometry(5.2, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#111', transparent: true, opacity: .12, depthWrite: false, side: THREE.DoubleSide }), 0, 0, 0, false);
    this.tailRotor = add(heli, new THREE.BoxGeometry(.05, 1.4, .12), std('#222', .6), .2, .8, -6.1, false);
    this.heli = heli; heli.position.set(0, 60, 0); this.live.add(heli);
    // Blimp orbiting high above the circuit.
    const skin = canvasTexture(1024, 2048, (c, w, h) => {
      c.fillStyle = '#e9ebea'; c.fillRect(0, 0, w, h); c.fillStyle = '#12375c'; c.fillRect(0, h * .46, w, h * .08);
      for (const u of [.25, .75]) { c.save(); c.translate(u * w, h / 2); c.rotate(u < .5 ? Math.PI / 2 : -Math.PI / 2); c.fillStyle = '#12375c'; c.font = 'italic 900 150px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(this.theme.blimp, 0, 0); c.restore(); }
    });
    const blimp = new THREE.Group(); const env = new THREE.SphereGeometry(8, 40, 24); env.scale(1, 3.6, 1); env.rotateZ(Math.PI / 2);
    add(blimp, env, new THREE.MeshStandardMaterial({ map: skin, roughness: .45, metalness: .1 }));
    add(blimp, new THREE.BoxGeometry(5, 2.2, 2.4).translate(2, -8.4, 0), std('#d0d3d2', .4, .3));
    for (const r of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) { const fin = add(blimp, new THREE.BoxGeometry(6, .3, 5), std('#12375c', .5)); fin.position.set(-24, Math.sin(r) * 5, Math.cos(r) * 5); fin.rotation.x = r; }
    this.blimp = blimp; this.live.add(blimp);
    this.heliTarget = new THREE.Vector3();
  }

  update(car, time, countdown, aerial = false) {
    const now = performance.now() / 1000, dt = clamp(now - this.clock, 0, .1); this.clock = now; TIME.value = now % 3600;
    const centre = this.centre.set(car.x, 0, car.z);
    const extent = aerial ? 90 : 48;
    if (this.shadowExtent !== extent) { Object.assign(this.sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent }); this.sun.shadow.camera.updateProjectionMatrix(); this.shadowExtent = extent; }
    const texel = extent * 2 / this.sun.shadow.mapSize.x;
    this.shadowRight.crossVectors(this.sunDirection, THREE.Object3D.DEFAULT_UP).normalize();
    this.shadowUp.crossVectors(this.shadowRight, this.sunDirection).normalize();
    const sx = centre.dot(this.shadowRight), sy = centre.dot(this.shadowUp);
    centre.addScaledVector(this.shadowRight, Math.round(sx / texel) * texel - sx).addScaledVector(this.shadowUp, Math.round(sy / texel) * texel - sy);
    this.sun.position.copy(centre).addScaledVector(this.sunDirection, 160); this.sun.target.position.copy(centre); this.sun.target.updateMatrixWorld();
    const wet = this.track.wetness || 0;
    if (wet !== this.visualWetness) {
      const s = wetSurface(wet); if ((this.roadMaterial.clearcoat > 0) !== (s.clearcoat > 0)) this.roadMaterial.needsUpdate = true;
      this.roadMaterial.roughness = s.roughness; this.roadMaterial.clearcoat = s.clearcoat; this.roadMaterial.color.setScalar(s.darken); this.visualWetness = wet;
    }
    this.startLights.forEach((l) => { const i = Math.floor(this.startLights.indexOf(l) / 2), on = countdown > 0 && countdown < 4 - i * .45; l.material.color.set(on ? '#ff2a12' : '#2a1412'); if (l.material.userData.glow) l.material.userData.glow.material.opacity = on ? .9 : 0; });
    if (Math.floor(time * 2) !== this.rubberTick) {
      this.rubberTick = Math.floor(time * 2); const color = this.rubberMesh.geometry.attributes.color;
      for (let i = 0; i < this.track.rubber.length; i++) { const v = 1 - this.track.rubber[i] * .86; for (let j = 0; j < 6; j++) color.setXYZ(i * 6 + j, v, v, v); }
      color.needsUpdate = true;
    }
    for (const a of this.animators) a(now);
    for (const st of this.stands) { const dist = st.centre.distanceTo(this.centre.set(car.x, 0, car.z)); const target = countdown > 0 ? .9 : clamp(1.4 - dist / 120, .25, 1); st.excite.value += (target - st.excite.value) * Math.min(1, dt * 2); }
    if (Math.floor(now * 5) !== this.screenTick) { this.screenTick = Math.floor(now * 5); this.drawScreen(car, now); }
    for (const s of this.smoke) {
      const u = s.userData; u.age += dt; if (u.age > u.life) u.age -= u.life;
      const k = u.age / u.life; s.position.set(u.x + k * 60 + Math.sin(u.age * .7) * 2, 50 + k * 45, u.z - k * 25); s.scale.setScalar(4 + k * 26); s.material.opacity = (1 - k) * .45 * Math.min(1, u.age * 2);
    }
    // Gulls wheel above the harbor side; each flock drifts along its own orbit.
    // Elsewhere the same flocks become birds circling over the infield.
    const bc = this.bounds, centres = this.theme.harbor ? [[640, 0], [900, 300], [760, -300], [300, 120]]
      : [[bc.cx, bc.cz], [bc.x0 + 200, bc.cz], [bc.x1 - 200, bc.cz + 150], [bc.cx, bc.z0 + 200]];
    this.gullSeeds.forEach((g, i) => {
      const c = centres[g.flock], a = now * g.sp + g.ph; this.dummy.position.set(c[0] + Math.cos(a) * g.r, g.h + Math.sin(now * .5 + i) * 3, c[1] + Math.sin(a) * g.r);
      this.dummy.rotation.set(0, -a, Math.sin(now + i) * .3); this.dummy.scale.setScalar(1); this.dummy.updateMatrix(); this.gulls.setMatrixAt(i, this.dummy.matrix);
    });
    this.gulls.instanceMatrix.needsUpdate = true;
    const heading = car.yaw ?? 0; this.heliTarget.set(car.x - Math.sin(heading) * 40 + Math.cos(heading) * 35, 48, car.z - Math.cos(heading) * 40 - Math.sin(heading) * 35);
    const prev = this.heli.position.clone(); this.heli.position.lerp(this.heliTarget, Math.min(1, dt * .6));
    const v = this.heli.position.clone().sub(prev); if (v.lengthSq() > 1e-4) { const yaw = Math.atan2(v.x, v.z); this.heli.rotation.y += Math.atan2(Math.sin(yaw - this.heli.rotation.y), Math.cos(yaw - this.heli.rotation.y)) * Math.min(1, dt * 1.5); this.heli.rotation.x = clamp(v.length() / Math.max(dt, 1e-3) * .006, 0, .25); }
    this.rotor.rotation.y += dt * 38; this.tailRotor.rotation.x += dt * 60;
    const b = now * .018, ox = this.theme.harbor ? 0 : this.bounds.cx, oz = this.theme.harbor ? 0 : this.bounds.cz; this.blimp.position.set(ox + Math.cos(b) * 420, 170 + Math.sin(now * .1) * 4, oz + Math.sin(b) * 320); this.blimp.rotation.y = Math.atan2(-Math.sin(b) * 420, Math.cos(b) * 320) - Math.PI / 2;
    this.clouds.position.copy(this.centre.set(0, 0, 0));
    if (this.stars) this.stars.position.set(car.x, 0, car.z);
    const lamp = aerial ? 0 : this.lamps, fx = Math.sin(heading), fz = Math.cos(heading);
    this.headlight.intensity = lamp * 380;
    this.headlight.position.set(car.x + fx * 2.1, (car.y ?? 0) + .75, car.z + fz * 2.1);
    this.headlight.target.position.set(car.x + fx * 40, (car.y ?? 0) - 1.5, car.z + fz * 40); this.headlight.target.updateMatrixWorld();
  }
}
