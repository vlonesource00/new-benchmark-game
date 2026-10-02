import * as THREE from 'three';

// GPU grass: a field of individual blades around the camera, one draw call.
// Every blade is an instance whose position wraps around the camera in the
// vertex shader, so the CPU never touches it after setup. A top-down render of
// the static scenery (everything but the ground) masks the blades away from the
// track, buildings, car parks and water, without any per-object bookkeeping.

const PATCH = 120;          // metres of grass around the camera
const DENSITY = { high: 22, ultra: 36 };   // blades per square metre
const MASK_RES = 2048;

const COLORS = {
  grass: ['#4f7230', '#a6c25e'],
  alpine: ['#46633e', '#93ad70']
};

function bladeGeometry() {
  // Three tapering segments; normals point up so blades light like the ground they grow from.
  const pos = [], col = [], idx = [];
  const rows = [[0, .07], [.4, .06], [.75, .036], [1, 0]];
  rows.forEach(([y, w], i) => {
    pos.push(-w, y, 0, w, y, 0);
    const c = .25 + .75 * y; col.push(c, c, c, c, c, c);
    if (i < rows.length - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  });
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

export class GrassField {
  constructor(world, renderer, kind = 'grass') {
    const rng = world.rng, n = Math.round(PATCH * PATCH * DENSITY.ultra);
    const geo = bladeGeometry(), off = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) off.set([rng() * PATCH, rng() * PATCH, .16 + rng() ** 2 * .4, rng() * Math.PI * 2], i * 4);
    geo.setAttribute('aBlade', new THREE.InstancedBufferAttribute(off, 4));
    geo.instanceCount = n; this.max = n;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

    const [base, tip] = (COLORS[kind] ?? COLORS.grass).map((c) => new THREE.Color(c));
    this.mask = this.renderMask(world, renderer);
    const uniforms = { uCam: { value: new THREE.Vector2() }, uPatch: { value: PATCH }, uMask: { value: this.mask.texture }, uMaskBox: { value: this.maskBox }, uBase: { value: base }, uTip: { value: tip }, uTime: world.timeUniform };
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .85, side: THREE.DoubleSide });
    material.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, uniforms);
      s.vertexShader = `attribute vec4 aBlade;uniform vec2 uCam;uniform float uPatch;uniform sampler2D uMask;uniform vec4 uMaskBox;uniform vec3 uBase,uTip;uniform float uTime;\n` + s.vertexShader
        .replace('#include <color_vertex>', `#include <color_vertex>
          vColor.rgb = mix(uBase, uTip, color.r) * (.85 + .3 * fract(aBlade.w * 7.3));`)
        .replace('#include <begin_vertex>', `
          vec2 org = uCam - uPatch * .5;
          vec2 wp = org + mod(aBlade.xy - org, uPatch);
          vec2 muv = vec2((wp.x - uMaskBox.x) / uMaskBox.z, (uMaskBox.y - wp.y) / uMaskBox.w);
          float inside = step(0., muv.x) * step(muv.x, 1.) * step(0., muv.y) * step(muv.y, 1.);
          float m = mix(1., 1. - textureLod(uMask, muv, 0.).r, inside);
          float edge = 1. - smoothstep(.35, 1., length(wp - uCam) / (uPatch * .5));
          float h = aBlade.z * smoothstep(.35, .9, m) * edge;
          float c = cos(aBlade.w), sn = sin(aBlade.w);
          vec3 transformed = vec3(position.x * c, position.y * h, position.x * sn);
          float gust = sin(uTime * 1.7 + wp.x * .13 + wp.y * .07) * .5 + sin(uTime * 3.1 + wp.x * .31) * .2;
          transformed.x += gust * position.y * position.y * h * .35;
          transformed.z += (fract(aBlade.w * 3.1) - .5) * position.y * position.y * h * .5;
          transformed.xz += wp;`);
    };
    material.customProgramCacheKey = () => 'gpu-grass';
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false; this.mesh.receiveShadow = true; this.mesh.castShadow = false;
    this.mesh.onBeforeRender = (r, scene, camera) => { uniforms.uCam.value.set(camera.position.x, camera.position.z); };
  }

  // White wherever static scenery other than the ground covers the terrain.
  renderMask(world, renderer) {
    const b = world.bounds, pad = 260, x0 = b.x0 - pad, x1 = b.x1 + pad, z0 = b.z0 - pad, z1 = b.z1 + pad;
    this.maskBox = new THREE.Vector4(x0, z1, x1 - x0, z1 - z0);
    const target = new THREE.WebGLRenderTarget(MASK_RES, MASK_RES, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    const cam = new THREE.OrthographicCamera(x0, x1, -z0, -z1, 1, 3000);
    cam.position.set(0, 1500, 0); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
    const scene = new THREE.Scene(), parent = world.root.parent;
    scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const hidden = world.groundMeshes.filter((m) => m.visible); for (const m of hidden) m.visible = false;
    scene.add(world.root);
    const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha(), prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(target); renderer.setClearColor('#000000', 1); renderer.clear(); renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget); renderer.setClearColor(prevClear, prevAlpha); renderer.shadowMap.autoUpdate = prevShadow;
    parent.add(world.root); for (const m of hidden) m.visible = true;
    scene.overrideMaterial.dispose();
    return target;
  }

  // Blades are scattered uniformly, so any prefix of them is an even, sparser field.
  setQuality(mode) {
    this.mesh.visible = mode === 'high' || mode === 'ultra';
    this.mesh.geometry.instanceCount = Math.round(this.max * (DENSITY[mode] ?? DENSITY.high) / DENSITY.ultra);
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mask.dispose(); }
}
