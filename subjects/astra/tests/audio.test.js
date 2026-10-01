import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../src/render/audio.js';
import { Vehicle } from '../src/sim/vehicle.js';

// Exercise graph automation without requiring an audio device in CI.
class Parameter {
  value=0;
  setTargetAtTime(value){assert.ok(Number.isFinite(value));this.value=value;}
  setValueAtTime(value){this.setTargetAtTime(value);}
  exponentialRampToValueAtTime(value){this.setTargetAtTime(value);}
}
class Node {
  constructor(){for(const key of ['gain','frequency','Q','pan','threshold','ratio','attack','release'])this[key]=new Parameter();}
  connect(){} disconnect(){} start(){} stop(){this.stopped=true;}
}
class Context {
  currentTime=1;sampleRate=8000;destination=new Node();
  createGain(){return new Node();} createBiquadFilter(){return new Node();}
  createOscillator(){return new Node();} createStereoPanner(){return new Node();}
  createDynamicsCompressor(){return new Node();} createBufferSource(){return new Node();}
  createBuffer(channels,length){return {getChannelData:()=>new Float32Array(length)};}
  async resume(){}
}

test('new audio layers stay finite, position opponents correctly and silence on pause',async()=>{
  const previous=globalThis.window;globalThis.window={AudioContext:Context};
  try{
    const audio=new AudioEngine();await audio.unlock();
    const player=new Vehicle(),rival=new Vehicle(1);
    player.speed=35;player.rpm=6500;player.controls.throttle=1;
    rival.x=5;rival.speed=30;rival.rpm=6000;
    audio.update(player,true,[player,rival]);
    assert.ok(audio.wind.gain.gain.value>0);
    const voice=audio.rivals.find(v=>v.id===1);assert.ok(voice.gain.gain.value>0);
    assert.ok(voice.pan.pan.value<0,'+X opponent is on the driver’s left');
    player.zone='gravel';audio.update(player,true,[player,rival]);assert.ok(audio.gravel.gain.gain.value>0);
    player.gear++;player.impact=.2;audio.update(player,true,[player,rival]);
    audio.update(player,false,[player,rival]);
    for(const layer of [audio.wind,audio.road,audio.gravel])assert.equal(layer.gain.gain.value,0);
    assert.equal(audio.engine.gain.value,0);assert.equal(audio.whine.gain.value,0);
    assert.ok(audio.rivals.every(v=>v.gain.gain.value===0));
    audio.toggle();assert.equal(audio.master.gain.value,0);
  }finally{globalThis.window=previous;}
});
