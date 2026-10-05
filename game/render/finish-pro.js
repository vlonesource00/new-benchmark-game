import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

// Tone mapping and sRGB output (three's OutputPass) fused with a filmic grade:
// split-tone, gentle S-curve, saturation, vignette, lens chromatic fringe at the
// frame edge and fine grain. One full-screen pass instead of two. The fringe taps
// land between texels, so they blend four tone-mapped texels by hand: filtering the
// HDR image first would smear highlights differently from the two-pass chain.
class GradedOutputPass extends OutputPass {
  constructor() {
    super();
    Object.assign(this.uniforms, { texel: { value: new THREE.Vector2(1, 1) }, time: { value: 0 }, vignette: { value: .32 }, fringe: { value: .0016 }, grain: { value: .022 }, speed: { value: 0 } });
    this.material.fragmentShader = `precision highp float;
    uniform sampler2D tDiffuse;uniform vec2 texel;uniform float time,vignette,fringe,grain,speed;
    #include <tonemapping_pars_fragment>
    #include <colorspace_pars_fragment>
    varying vec2 vUv;
    vec3 tone(vec2 uv){
      vec3 c=texture2D(tDiffuse,uv).rgb;
      #ifdef LINEAR_TONE_MAPPING
        c=LinearToneMapping(c);
      #elif defined(REINHARD_TONE_MAPPING)
        c=ReinhardToneMapping(c);
      #elif defined(CINEON_TONE_MAPPING)
        c=OptimizedCineonToneMapping(c);
      #elif defined(ACES_FILMIC_TONE_MAPPING)
        c=ACESFilmicToneMapping(c);
      #elif defined(AGX_TONE_MAPPING)
        c=AgXToneMapping(c);
      #elif defined(NEUTRAL_TONE_MAPPING)
        c=NeutralToneMapping(c);
      #endif
      #ifdef SRGB_TRANSFER
        c=sRGBTransferOETF(vec4(c,1.)).rgb;
      #endif
      return c;
    }
    vec3 toneLerp(vec2 uv){
      vec2 p=uv/texel-.5,i=floor(p),f=p-i;uv=(i+.5)*texel;
      return mix(mix(tone(uv),tone(uv+vec2(texel.x,0.)),f.x),mix(tone(uv+vec2(0.,texel.y)),tone(uv+texel),f.x),f.y);
    }
    float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233))+time*37.)*43758.5453);}
    void main(){
      vec2 d=vUv-.5;float r=dot(d,d);
      float f=fringe*(1.+speed*1.5)*r*4.;
      vec3 c=vec3(toneLerp(vUv-d*f).r,tone(vUv).g,toneLerp(vUv+d*f).b);
      float l=dot(c,vec3(.2126,.7152,.0722));
      c=mix(vec3(l),c,1.12);
      c+=mix(vec3(-.012,.004,.022),vec3(.022,.008,-.018),smoothstep(.15,.7,l));
      c=mix(c,c*c*(3.-2.*c),.22);
      c*=1.-vignette*smoothstep(.12,.72,r*(1.+speed*.4));
      c+=(h(vUv*1000.)-.5)*grain;
      gl_FragColor=vec4(max(c,0.),1.);
    }`;
  }
  render(renderer, writeBuffer, readBuffer, ...rest) {
    this.uniforms.texel.value.set(1 / readBuffer.width, 1 / readBuffer.height);
    super.render(renderer, writeBuffer, readBuffer, ...rest);
  }
}

// Ambient occlusion from the beauty pass's own depth buffer: no second scene
// render, so it costs GPU time only. GTAOPass expects a normal target to exist
// even when it reconstructs normals from depth; a stub stands in for it.
// The blend raises AO to a power (blendIntensity) instead of mixing, which
// keeps open ground clean while deepening contact shadows under cars and stands.
class DepthGTAOPass extends GTAOPass {
  constructor(...args) {
    super(...args);
    this.blendMaterial.fragmentShader = this.blendMaterial.fragmentShader.replace('vec4(mix(vec3(1.), texel.rgb, intensity), texel.a)', 'vec4(vec3(pow(clamp(texel.r, 0., 1.), intensity)), texel.a)');
  }
}
DepthGTAOPass.prototype.normalRenderTarget = { depthTexture: null, setSize() {}, dispose() {} };

export class VisualFinish {
  constructor(renderer, scene, camera) {
    this.renderer = renderer; this.scene = scene; this.camera = camera; this.mode = 'performance'; this.speed = 0;
    renderer.info.autoReset = false;
  }
  setQuality(mode) {
    this.mode = mode;
    if (mode !== 'performance' && !this.composer) {
      const w = Math.max(1, Math.floor(window.innerWidth || 1280)), h = Math.max(1, Math.floor(window.innerHeight || 720));
      const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, samples: 0 });
      target.depthTexture = new THREE.DepthTexture(w, h); target.depthTexture.type = THREE.UnsignedIntType;
      this.composer = new EffectComposer(this.renderer, target);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.ao = new DepthGTAOPass(this.scene, this.camera, w, h, { depthTexture: target.depthTexture }, { radius: 2, distanceExponent: 1, thickness: 3, scale: 1.5, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
      this.ao.blendIntensity = 3; this.composer.addPass(this.ao);
      this.bloom = new UnrealBloomPass(new THREE.Vector2(Math.max(64, w >> 1), Math.max(64, h >> 1)), .22, .55, .92);
      this.composer.addPass(this.bloom);
      this.grade = new GradedOutputPass(); this.composer.addPass(this.grade);
      try { this.aa = new SMAAPass(w, h); } catch { this.aa = new ShaderPass({ ...FXAAShader, fragmentShader: FXAAShader.fragmentShader.replaceAll('-100.0', '-16.0') }); this.fxaa = this.aa; }
      this.composer.addPass(this.aa);
    }
    if (this.bloom) { this.bloom.strength = mode === 'ultra' ? .3 : .22; this.bloom.threshold = .92; }
    if (this.ao) { this.ao.enabled = mode === 'high' || mode === 'ultra'; this.ao.updateGtaoMaterial({ samples: mode === 'ultra' ? 24 : 12 }); }
    this.resize(Math.floor(window.innerWidth || 1280), Math.floor(window.innerHeight || 720));
  }
  setSpeed(speed) { this.speed = speed; }
  resize(width, height) {
    if (!this.composer) return;
    const w = Math.max(1, Math.floor(width || 1)), h = Math.max(1, Math.floor(height || 1)), ratio = this.renderer.getPixelRatio() || 1;
    this.composer.setPixelRatio(ratio); this.composer.setSize(w, h);
    if (this.fxaa?.material?.uniforms?.resolution) this.fxaa.material.uniforms.resolution.value.set(1 / (w * ratio), 1 / (h * ratio));
  }
  render() {
    this.renderer.info.reset();
    if ((this.renderer.domElement?.width ?? 0) <= 0 || (this.renderer.domElement?.height ?? 0) <= 0) return;
    if (this.mode === 'performance') { this.renderer.render(this.scene, this.camera); return; }
    const u = this.grade.uniforms; u.time.value = performance.now() / 1000 % 100; u.speed.value = Math.min(1, this.speed / 80);
    if (this.ao?.enabled) {
      // The beauty pass draws into whichever target is the read buffer this frame.
      const depth = this.composer.readBuffer.depthTexture;
      this.ao.gtaoMaterial.uniforms.tDepth.value = this.ao.pdMaterial.uniforms.tDepth.value = depth;
    }
    try { this.composer.render(); } catch (err) { this.renderer.render(this.scene, this.camera); }
  }
  // WebGL builds a shader program the first time a material is drawn, which can
  // stall that frame for 50-250 ms (worst on Firefox/ANGLE). One frame drawn behind
  // the loading screen with nothing culled or hidden builds every program the race
  // will need, through the same post chain and shadow pass, so the variants match.
  // Lights keep their state: the light count is part of every program's key.
  warm() {
    const lit = new Set(), shown = [], unculled = [], doused = [], opaque = [];
    this.scene.traverseVisible((o) => { if (o.isLight) lit.add(o); });
    this.scene.traverse((o) => {
      if (o.isLight) return;
      if (!o.visible) { o.visible = true; shown.push(o); }
      if (o.frustumCulled) { o.frustumCulled = false; unculled.push(o); }
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) if (!m.visible) { m.visible = true; opaque.push(m); }
    });
    this.scene.traverseVisible((o) => { if (o.isLight && !lit.has(o)) { o.visible = false; doused.push(o); } });
    try { this.renderer.shadowMap.needsUpdate = true; this.render(); } finally {
      for (const o of shown) o.visible = false;
      for (const o of unculled) o.frustumCulled = true;
      for (const o of doused) o.visible = true;
      for (const m of opaque) m.visible = false;
    }
  }
}
