import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

export class VisualFinish {
  constructor(renderer,scene,camera){
    this.renderer=renderer;this.scene=scene;this.camera=camera;this.mode='performance';renderer.info.autoReset=false;
  }
  setQuality(mode){
    this.mode=mode;
    if(mode!=='performance'&&!this.composer){
      const target=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,samples:4});
      this.composer=new EffectComposer(this.renderer,target);
      this.composer.addPass(new RenderPass(this.scene,this.camera));
      this.bloom=new UnrealBloomPass(new THREE.Vector2(512,512),.13,.45,1.6);this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
      // The upstream shader's -100 bias exceeds ANGLE's supported range.
      this.fxaa=new ShaderPass({...FXAAShader,fragmentShader:FXAAShader.fragmentShader.replaceAll('-100.0','-16.0')});this.composer.addPass(this.fxaa);
    }
    if(this.bloom)this.bloom.strength=mode==='ultra'?.2:.12;
    this.resize(innerWidth,innerHeight);
  }
  resize(width,height){
    if(!this.composer)return;
    const ratio=this.renderer.getPixelRatio();this.composer.setPixelRatio(ratio);this.composer.setSize(width,height);
    this.fxaa.material.uniforms.resolution.value.set(1/(width*ratio),1/(height*ratio));
  }
  render(){this.renderer.info.reset();if(this.mode==='performance')this.renderer.render(this.scene,this.camera);else this.composer.render();}
}
