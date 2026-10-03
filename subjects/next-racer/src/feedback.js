// The worker owns route choice; native physics owns its immediate feedback.
// Serialized geometry is data, not executable policy or an opponent intent.
import { ForceControl } from './control.js';
import { angle,clamp,distance } from './math.js';
import { projectCourse,advanceCourse } from './course.js';

const executors=new WeakMap();
export function resetFeedback(car){executors.delete(car);}
export function feedbackDebug(car){return executors.get(car)?.debug??null;}

export function previewFeedback(car,track,preview,time){
  const invalid=()=>{const executor=executors.get(car);if(executor){executor.debug=null;executor.controls=null;}return null;};
  if(!Number.isFinite(time)||!Array.isArray(preview?.course)||![preview.time,preview.s,preview.factor,preview.rotation].every(Number.isFinite)||time<preview.time-1e-8
    ||time-preview.time>.4||preview.course.length<2)return invalid();
  let executor=executors.get(car);
  if(!executor||executor.track!==track){
    executor={track,preview:null};executors.set(car,executor);
  }
  if(executor.preview!==preview){
    const points=preview.course;
    if(points.some(p=>!Array.isArray(p)||p.length!==8||p.some(v=>!Number.isFinite(v))))return invalid();
    const start=points[0][0],step=points[1][0]-start;
    if(step<=0||points.some((p,i)=>Math.abs(p[0]-start-i*step)>1e-6))return invalid();
    const at=s=>{
      const d=distance(s,preview.s,track.length),u=clamp((d-start)/step,0,points.length-1),
        i=Math.min(points.length-2,Math.floor(u)),a=points[i],b=points[i+1],t=u-i;
      const mix=k=>a[k]+(b[k]-a[k])*t;
      return {x:mix(1),z:mix(2),heading:angle(a[3]+angle(b[3]-a[3])*t),
        curvature:mix(4),speed:Math.max(0,mix(5)),offset:mix(6),metric:mix(7)};
    };
    const course={x:points.map(p=>p[1]),z:points.map(p=>p[2]),step,period:track.length,
      start:preview.s+start,closed:false};
    const route={at,speed:points,project:(x,z,hint)=>projectCourse(course,x,z,hint),
      advance:(s,metres)=>advanceCourse(course,s,metres)},path={at,sample:(_,s)=>at(s).speed};
    executor.control=new ForceControl(track,path,preview.policy);
    executor.route=route;executor.preview=preview;
  }
  const p=track.nearest(car.x,car.z),control=executor.control;
  // The snapshot command and the first host evaluation share a timestamp.
  // Re-evaluating that instant must not apply the steering slew twice.
  const atSnapshot=Math.abs(time-preview.time)<1e-8;
  const repeated=time===executor.time;
  const dt=repeated?executor.dt:atSnapshot?(preview.controlPeriod??1/120):
    executor.time==null?1/120:Math.max(1/240,time-executor.time);
  const origin=repeated?executor.origin:atSnapshot?preview.steerOrigin:
    executor.controls&&time>=executor.time&&time-executor.time<.2?executor.controls.steer:car.controls?.steer;
  const k=control.control(car,p,{route:executor.route,factor:preview.factor,rotation:preview.rotation,
    dt,
    // AsyncSeats restores the last worker command before every host tick.
    // Slew from the last command actually issued by this executor instead;
    // otherwise steering stays pinned to an old reply throughout its delay.
    steerOrigin:origin,steerBias:preview.steerBias,
    push:preview.push,cornerUse:preview.cornerUse,
    lookahead:preview.lookahead,brakeAction:preview.brakeAction,forceGuard:1},
    time<preview.yieldUntil?preview.yieldSpeed:Infinity);
  if(preview.brakeMin){k.throttle=0;k.brake=Math.max(k.brake,preview.brakeMin);}
  executor.time=time;
  executor.origin=origin;executor.dt=dt;
  executor.controls=k;
  executor.debug={trackingPoint:control.lastTarget?{x:control.lastTarget.x,z:control.lastTarget.z}:null,
    targetSpeed:control.targetSpeed,feedbackHz:120,control:control.lastSignal};
  return k;
}
