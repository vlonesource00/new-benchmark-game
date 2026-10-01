import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { Vehicle, collisions, wakes } from '../src/sim/vehicle.js';
import { createTyre, tyreForce } from '../src/sim/tyre.js';

const straightTrack={at:s=>({x:0,z:s,tx:0,tz:1,heading:0,s}),surface:(x,z)=>({s:z,lateral:x,nx:1,nz:0,tx:0,tz:1,grip:1,bump:0,resistance:.013,zone:'asphalt'}),deposit(){}};

test('circuit is closed, arc-length queries and projection agree', () => {
  const track = new Track();
  assert.ok(track.length > 2900 && track.length < 3100);
  for (let s = 0; s < track.length; s += 37) {
    const p = track.at(s,2), n = track.nearest(p.x,p.z);
    assert.ok(Math.abs(n.lateral - 2) < 0.15);
    assert.ok(Math.hypot(p.tx,p.tz) > 0.999);
  }
  assert.deepEqual(track.at(0),track.at(track.length));
});
test('combined-slip forces stay bounded, heat causes absolute-pressure increase', () => {
  const tyre = createTyre(); const initial = tyre.core;
  for (let i = 0; i < 6000; i++) {
    tyreForce(tyre,{vx:40,vy:5,omega:140,radius:0.335,load:3300,grip:1},1/120);
    assert.ok(Math.hypot(tyre.fx,tyre.fy) < 6000);
  }
  assert.ok(tyre.core > initial); assert.ok(tyre.pressure > tyre.coldPressure); assert.ok(tyre.wear > 0);
  const unloaded = createTyre(); tyreForce(unloaded,{vx:10,vy:2,omega:40,radius:.335,load:0,grip:1},1/120);
  assert.equal(unloaded.fx,0); assert.equal(unloaded.fy,0);
});
test('stationary car remains stable and throttle accelerates without nonfinite state', () => {
  const track = straightTrack, car = new Vehicle(); car.place(track,100);
  for (let i=0;i<600;i++) car.step(1/120,track);
  assert.ok(car.speed < 0.2);
  car.controls.throttle = 1;
  for (let i=0;i<1200;i++) { car.step(1/120,track); assert.ok(Number.isFinite(car.x+car.z+car.yaw)); }
  assert.ok(car.speed > 25,`speed ${car.speed}`);
  assert.ok(car.aero.downforce > 1000);
});
test('braking dissipates speed and raises brake temperatures', () => {
  const track = straightTrack, car = new Vehicle(); car.place(track,100,0,45); car.controls.brake = 1;
  for (let i=0;i<600;i++) car.step(1/120,track);
  assert.ok(car.speed < 3,`speed ${car.speed}`);
  assert.ok(car.wheels[0].brakeTemp > 180);
});
test('collision separates bodies; wake requires alignment behind a car', () => {
  const a = new Vehicle(0), b = new Vehicle(1); a.z = 0; b.z = 3; a.vz = 20; b.vz = 10;
  collisions([a,b]); assert.ok(b.z-a.z > 4.5); assert.ok(a.vz < 20);
  a.z = -20; b.z = 0; assert.ok(wakes([a,b])[0] > 0.3);
  a.x = 20; assert.equal(wakes([a,b])[0],0);
});
