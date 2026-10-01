import test from 'node:test';
import assert from 'node:assert/strict';
import { Keyboard } from '../src/sim/input.js';

import { PerspectiveCamera, Vector3 } from 'three';
import { Vehicle } from '../src/sim/vehicle.js';

const straightTrack={at:s=>({x:0,z:s,tx:0,tz:1,heading:0,s}),surface:(x,z)=>({s:z,lateral:x,nx:1,nz:0,tx:0,tz:1,grip:1,bump:0,resistance:.013,zone:'asphalt'}),deposit(){}};

test('A/left and D/right turn the moving car in the correct camera direction',()=>{
  const originalWindow=globalThis.window, listeners={};
  globalThis.window={addEventListener:(name,fn)=>{listeners[name]=fn;}};
  try{
    const keyboard=new Keyboard(()=>{});
    const camera=new PerspectiveCamera(55,1,.3,1000);
    camera.position.set(0,3,-8);camera.lookAt(0,0,20);camera.updateMatrixWorld();
    for(const assisted of [false,true])for(const [code,screenSign] of [['KeyA',-1],['ArrowLeft',-1],['KeyD',1],['ArrowRight',1]]){
      keyboard.clear();
      const car=new Vehicle();car.place(straightTrack,0,0,15);
      listeners.keydown({code,target:{tagName:'BODY'},repeat:false,preventDefault(){}});
      for(let step=0;step<72;step++){
        car.controls=keyboard.update(car,1/120,assisted);car.step(1/120,straightTrack);
      }
      const projected=new Vector3(car.x,0,car.z).project(camera);
      assert.ok(projected.x*screenSign>.005,`${code}, assisted=${assisted}: car moved to screen x=${projected.x}`);
      const nose=new Vector3(car.x+Math.sin(car.yaw)*2,0,car.z+Math.cos(car.yaw)*2).project(camera);
      assert.ok((nose.x-projected.x)*screenSign>0,`${code}: nose points the wrong way`);
      listeners.keyup({code});assert.equal(keyboard.down(code),false);
    }
  }finally{globalThis.window=originalWindow;}
});
