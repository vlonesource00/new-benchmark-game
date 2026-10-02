import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

// Filmic grade applied after tone mapping: split-tone, gentle S-curve,
// saturation, vignette, lens chromatic fringe at the frame edge and fine grain.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, vignette: { value: .32 }, fringe: { value: .0016 }, grain: { value: .022 }, speed: { value: 0 } },
  vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
  fragmentShader: `uniform sampler2D tDiffuse;uniform float time,vignette,fringe,grain,speed;varying vec2 vUv;
    float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233))+time*37.)*43758.5453);}
    void main(){
      vec2 d=vUv-.5;float r=dot(d,d);
      float f=fringe*(1.+speed*1.5)*r*4.;
      vec3 c=vec3(texture2D(tDiffuse,vUv-d*f).r,texture2D(tDiffuse,vUv).g,texture2D(tDiffuse,vUv+d*f).b);
      float l=dot(c,vec3(.2126,.7152,.0722));
      c=mix(vec3(l),c,1.12);
      c+=mix(vec3(-.012,.004,.022),vec3(.022,.008,-.018),smoothstep(.15,.7,l));
      c=mix(c,c*c*(3.-2.*c),.22);
      c*=1.-vignette*smoothstep(.12,.72,r*(1.+speed*.4));
      c+=(h(vUv*1000.)-.5)*grain;
      gl_FragColor=vec4(max(c,0.),1.);
    }`
};

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
      this.composer.addPass(new OutputPass());
      this.grade = new ShaderPass(GradeShader); this.composer.addPass(this.grade);
      try { this.aa = new SMAAPass(w, h); } catch { this.aa = new ShaderPass({ ...FXAAShader, fragmentShader: FXAAShader.fragmentShader.replaceAll('-100.0', '-16.0') }); this.fxaa = this.aa; }
      this.composer.addPass(this.aa);
    }
    if (this.bloom) { this.bloom.strength = mode === 'ultra' ? .3 : .22; this.bloom.threshold = .92; }
    if (this.ao) this.ao.enabled = mode === 'high' || mode === 'ultra';
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
}
