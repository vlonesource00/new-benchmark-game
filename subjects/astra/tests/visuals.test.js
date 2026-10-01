import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { surfacePixels, surfaceMaps, wetSurface } from '../src/render/surfaces.js';
import { WeatherEffects } from '../src/render/weather.js';
import { readFileSync } from 'node:fs';

test('surface textures are deterministic, correctly typed and shared across cars',()=>{
  for(const kind of ['asphalt','gravel','grass','carbon']){
    const pixels=surfacePixels(kind,32);
    assert.equal(pixels.color.length,32*32*4);
    assert.deepEqual(pixels.color,surfacePixels(kind,32).color);
    assert.ok(new Set(pixels.color).size>12);
    const maps=surfaceMaps(kind);assert.equal(maps,surfaceMaps(kind));
    assert.equal(maps.map.colorSpace,THREE.SRGBColorSpace);
    assert.equal(maps.bumpMap.colorSpace,THREE.NoColorSpace);
    assert.equal(maps.roughnessMap.colorSpace,THREE.NoColorSpace);
  }
});

test('wet surface response is bounded and becomes darker and smoother',()=>{
  const dry=wetSurface(0),wet=wetSurface(1);
  assert.ok(wet.roughness<dry.roughness&&wet.darken<dry.darken&&wet.clearcoat>dry.clearcoat);
  assert.deepEqual(wetSurface(-1),dry);assert.deepEqual(wetSurface(2),wet);assert.deepEqual(wetSurface(NaN),dry);
});

test('weather geometry stays bounded and dry conditions remove rain',()=>{
  const scene=new THREE.Scene(),weather=new WeatherEffects(scene,40),buffer=weather.rain.geometry.attributes.position.array;
  weather.update({x:30,z:50},.016,.75);
  assert.equal(weather.rain.visible,true);assert.equal(weather.rain.geometry.drawRange.count,60);
  for(let i=0;i<100;i++)weather.update({x:i,z:i},.016,1);
  assert.equal(weather.rain.geometry.attributes.position.array,buffer);assert.ok(buffer.every(Number.isFinite));
  weather.update({x:0,z:0},.016,0);assert.equal(weather.rain.visible,false);assert.equal(scene.children.length,1);
});

test('Blender wheel is a self-contained glTF with three shared material batches',()=>{
  const bytes=readFileSync(new URL('../public/assets/gt-wheel.glb',import.meta.url));
  assert.equal(bytes.readUInt32LE(0),0x46546c67);assert.equal(bytes.readUInt32LE(4),2);
  const length=bytes.readUInt32LE(12),gltf=JSON.parse(bytes.subarray(20,20+length).toString());
  assert.equal(gltf.meshes.length,3);assert.equal(gltf.materials.length,3);assert.ok(gltf.buffers.every(b=>!b.uri));
  assert.ok(bytes.length<750000,'wheel must remain small enough for mobile delivery');
});
