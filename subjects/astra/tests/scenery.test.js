import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Track } from '../src/sim/track.js';
import { RivieraScenery } from '../src/render/scenery.js';

test('new instanced scenery stays outside the racing surface and runoff',()=>{
  const root=new THREE.Group(),track=new Track(),scenery=new RivieraScenery(root,track);
  const matrix=new THREE.Matrix4(),position=new THREE.Vector3();
  for(const mesh of root.children){
    if(!mesh.isInstancedMesh)continue;
    for(let i=0;i<mesh.count;i++){
      mesh.getMatrixAt(i,matrix);position.setFromMatrixPosition(matrix);
      assert.ok(Math.abs(track.nearest(position.x,position.z).lateral)>16,`scenery on runoff: ${position.x}, ${position.z}`);
    }
  }
  scenery.update(12);assert.equal(scenery.time.value,12);
  assert.ok(root.children.length<=14,'scenery must remain batched');
});
