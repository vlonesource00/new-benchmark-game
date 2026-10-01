import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { driverSide, diagramX, cornerContext, tacticalSummary } from '../src/render/tactical-summary.js';
import { Track } from '../src/sim/track.js';
import { RacingLine } from '../src/sim/ai.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { AdaptiveDriver } from '../src/sim/controller.js';

test('proximity diagram agrees with driver-camera left and right at every heading',()=>{
  for(const yaw of [0,Math.PI/2,Math.PI,-Math.PI/2]){
    const forward=new Vector3(Math.sin(yaw),0,Math.cos(yaw)),normal=new Vector3(Math.cos(yaw),0,-Math.sin(yaw));
    const camera=new PerspectiveCamera(56,1,.1,1000);
    camera.position.copy(forward).multiplyScalar(-27);camera.position.y=65;
    camera.lookAt(forward.clone().multiplyScalar(27));camera.updateMatrixWorld();
    for(const lateral of [-3,3]){
      const projected=normal.clone().multiplyScalar(lateral).project(camera);
      assert.equal(Math.sign(projected.x),Math.sign(diagramX(lateral)-110));
      assert.equal(driverSide(lateral),projected.x<0?'Left':'Right');
    }
  }
});

test('inside and outside labels follow physical turn direction, not a mirrored normal',()=>{
  for(const sign of [-1,1]){
    const track={at:s=>({heading:sign*s/80})};
    const turn=cornerContext(track,0,30);
    assert.equal(turn.sign,sign);
    assert.equal(turn.inside,sign>0?'Left':'Right');
    assert.equal(turn.outside,sign>0?'Right':'Left');
  }
});

test('tactical explanations do not mutate candidate scoring or rival memory',()=>{
  const track=new Track('harbor-ring'),line=new RacingLine(track),car=new Vehicle(0),rival=new Vehicle(1);
  car.place(track,500,0,30);rival.place(track,525,0,27);
  const driver=new AdaptiveDriver(0,line);driver.planner.age=5;driver.update(car,[car,rival],1/120);
  const planner=driver.planner;
  const snapshot=()=>JSON.stringify({controls:car.controls,points:planner.plan.points,candidates:planner.candidates.map(p=>[p.score,p.hardConflict]),memory:[...planner.perception.history]});
  const before=snapshot(),summary=tacticalSummary(planner,car);
  assert.equal(snapshot(),before);
  assert.ok(Number.isFinite(summary.selected.secondsSaved));
  assert.ok(summary.selected.conflict>=0&&summary.selected.conflict<=1);
  assert.ok(summary.alternatives.every(p=>p.reason.length>10));
});
