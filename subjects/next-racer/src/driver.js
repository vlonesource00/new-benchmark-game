import { Road } from './road.js';
import { ForceControl } from './control.js';
import { Observer } from './observation.js';
import { Episodes } from './episode.js';
import { Resources } from './resources.js';
import { generateRoutes,refugeRoutes } from './routes.js';
import { choosePlan } from './search.js';
import { guardControls,reverseSpace } from './safety.js';
import { escapePrefix,escapeControl,actuationState } from './plant.js';
import { PitGuide,drivingTrack } from './pit.js';
import { angle, clamp } from './math.js';

const clock=()=>globalThis.performance?.now?.()??Date.now();
export class SpearheadDriver {
  constructor(track,options={}) {
    this.track=track;this.o=options;
    this.observer=new Observer(track);this.episodes=new Episodes(track);this.resources=new Resources(track);
    this.stats={updates:0,plans:0,rollouts:0,latencyMs:0,maxLatencyMs:0,emergencies:0,passes:0};
    this.epoch=0;this.reset();
  }
  reset() {
    this.epoch++;this.nextPlan=-Infinity;this.nextEnvelope=-Infinity;
    this.observer.reset();this.episodes.reset();this.resources.reset();
    this.plan=null;this.selected=null;this.stalled=0;this.reverseUntil=-Infinity;
    this.lifecycle='INIT';this.lastState=null;this.lastTime=null;this.checks=[];
    this.targetSpeed=0;this.trackingPoint=null;this.safetyReason=null;
  }
  prepare(car,count=1) {
    if(this.road)return;
    const start=clock();
    const environment=drivingTrack(this.track,count);
    this.road=new Road(environment.track,{...this.o.path,car});
    const physical={...this.o.policy,warmForceTransition:false,
      ...(car.classId==='lmdh'?{cornerGripUse:.88,warmCornerGripUse:.84,previewBrake:12}:{previewBrake:8})};
    this.control=new ForceControl(environment.track,this.road,physical);
    this.validator=new ForceControl(environment.track,this.road,physical);
    this.road.rebuildEnvelope(car,this.control.o.gripUse);
    this.pitGuide=new PitGuide(environment.track,this.road,car,count,this.control.o,environment.lane);
    this.stats.initMs=clock()-start;
  }
  update(car,cars,dt,context={}) {
    const start=clock();this.prepare(car,cars.length);
    const state=context.state??{},obs=this.observer.observe(car,cars,context,dt,this.road),p=obs.projection;
    const lifecycle=car.race?.finishTime!=null?'FINISHED':state.phase==='countdown'?'PRIME':
      state.formation?'FORMATION_PREVIEW':state.pit?'PIT_'+state.pit.toUpperCase():
      state.session==='qualifying'?((car.race?.progress??0)<0?'QUALIFY_OUT':'QUALIFY_PUSH'):'RACE';
    if(this.lifecycle!==lifecycle) {
      this.nextPlan=-Infinity;this.plan=null;
      if(this.lifecycle==='FORMATION_PREVIEW'||lifecycle.startsWith('PIT_'))this.episodes.resetBattle();
    }
    this.lifecycle=lifecycle;this.lastState=state;this.lastTime=obs.time;
    const resource=this.resources.update(car,obs,{...state,totalLaps:context.totalLaps??state.totalLaps});
    if(obs.time>=this.nextEnvelope){
      const wet=clamp(((this.track.wetness??0)-.08)/.14,0,1),grip=this.control.o.gripUse;
      this.road.rebuildEnvelope(car,grip+(Math.min(grip,.86)-grip)*wet);
      this.nextEnvelope=obs.time+1/(this.o.envelopeHz??2);
    }
    const forbidden=this.o.maneuvers===false||lifecycle==='FINISHED'||state.formation||state.phase==='countdown'||state.session==='qualifying'
      ||state.flag==='yellow'||state.flag==='red'||state.flag==='blue';
    const episode=this.episodes.update(car,obs,forbidden);
    const application=actuationState(car,obs,this.control);
    const pit=this.pitGuide.update(application.car,application.projection,state);
    if(pit) {car.controls=pit;this.trackingPoint=this.pitGuide.control.lastTarget;
      this.targetSpeed=this.pitGuide.control.targetSpeed;this.selected={kind:'pit',side:0};this.plan=null;}
    else {
      const headingError=angle(p.heading-car.yaw);
      if(obs.fresh)this.stalled=car.speed<1.5&&lifecycle==='RACE'&&obs.time>6?this.stalled+obs.elapsed:0;
      const canReverse=this.stalled>1.5||obs.time<this.reverseUntil?reverseSpace(car,cars):false;
      if(this.stalled>1.5 && obs.time>=this.reverseUntil&&canReverse)this.reverseUntil=obs.time+1.4;
      if(obs.time<this.reverseUntil&&canReverse) {
        this.lifecycle='RECOVER';car.controls={throttle:.45,brake:0,steer:clamp(-headingError*1.5,-1,1),reverse:true};
      } else if(Math.abs(headingError)>1.2&&car.speed>4) {
        this.lifecycle='RECOVER';car.controls={throttle:.1,brake:.25,steer:clamp(headingError*1.5,-1,1)};
      } else {
        const urgent=!this.plan||this.plan.role!==episode.role||this.plan.episode!==episode.id
          ||(episode.target&&this.plan.target!==episode.target.id);
        if(obs.time>=this.nextPlan||urgent) {
          const routes=generateRoutes(this.road,car,obs,this.o.maneuvers===false?{role:'pace',target:null}:episode);
          const previous=this.plan?.route;
          if(this.o.maneuvers!==false&&previous&&previous.kind!=='free'&&previous.kind!=='follow'
            &&this.plan.target===episode.target?.id&&episode.target&&this.plan.role===episode.role
            &&this.plan.episode===episode.id
            &&(episode.stage!=='Alongside'||previous.side===episode.side)
            &&obs.time-previous.created<7){
            // Re-evaluate the committed geometry with current tyre/force data.
            // Retention never reuses an old speed envelope or skips a veto.
            previous.refresh();routes.push(previous);previous.continuation=true;
          }
          let result;
          const settings=obs.rivals.some(r=>Math.abs(r.gap)<100)?this.o:{...this.o,horizon:2.4};
          // Test ablation: retain the same force controller and traffic guard,
          // but follow the nominal line without a maneuver search or escape.
          result=this.o.maneuvers===false?{route:routes[0],checks:[],evaluated:[]}:
            choosePlan(this.road,car,obs,routes,episode,resource,this.validator,settings);
          this.checks=result.checks;this.evaluated=result.evaluated??[];
          this.stats.plans++;this.stats.rollouts+=result.checks.length;
          if(result.route) {
            this.plan={route:result.route,target:episode.target?.id??null,role:episode.role,episode:episode.id,
              created:obs.time,epoch:this.epoch,native:result.native,validUntil:obs.time+.5};
            this.plan.factor=result.controlFactor??1;
            this.plan.brakeAction=result.brakeAction;
            this.selected={kind:result.route.kind,side:result.route.side};
            this.episodes.accept(result.route,obs);
          } else {
            const escapes=refugeRoutes(this.road,car,obs,routes[0]).map(route=>({route,
              escape:escapePrefix(car,obs,this.validator,resource,route)}));
            escapes.sort((a,b)=>Number(b.escape.feasible)-Number(a.escape.feasible)
              ||b.escape.score-a.escape.score);
            const {route:refuge,escape}=escapes[0];
            this.plan={route:refuge,target:episode.target?.id??null,role:episode.role,episode:episode.id,
              created:obs.time,epoch:this.epoch,validUntil:obs.time+.2};
            this.plan.escape=escape;
            this.selected={kind:refuge.kind==='emergency-hold'?'emergency-hold':'emergency-join',side:refuge.side};
            this.stats.emergencies++;
          }
          this.nextPlan=obs.time+1/(this.o.planHz??6);
        }
        const route=this.plan.route;
        const commandCar=application.car,commandProjection=application.projection;
        const nominal=this.control.control(commandCar,commandProjection,{route,factor:resource.factor*(this.plan.factor??.9),rotation:resource.rotation,
          brakeAction:this.plan.brakeAction??true,
          forceGuard:clamp((obs.elapsed-.025)/.015,0,1)},
          obs.time+application.lag<route.created+(route.yieldFor??0)?route.yieldSpeed:Infinity);
        const command=this.plan.escape?escapeControl(commandCar,commandProjection,this.control,resource,route,this.plan.escape.action):nominal;
        const safe=guardControls(car,cars,this.track,command,{route});
        car.controls=safe.controls;
        this.safetyReason=this.plan.escape?(this.plan.escape.feasible?'validated-escape':'best-effort-escape'):safe.reason;
        this.targetSpeed=this.control.targetSpeed;this.trackingPoint=this.control.lastTarget;
      }
    }
    this.stats.updates++;this.stats.passes=this.episodes.completed;
    this.stats.latencyMs=clock()-start;this.stats.maxLatencyMs=Math.max(this.stats.maxLatencyMs,this.stats.latencyMs);
    return car.controls;
  }
  debug() {
    return {architecture:'SPEARHEAD',intent:this.lifecycle==='RACE'?this.episodes.role.toUpperCase():this.lifecycle,
      stage:this.episodes.stage,target:this.episodes.target,side:this.episodes.side,
      targetSpeed:this.targetSpeed,plan:this.selected,epoch:this.epoch,
      trackingPoint:this.trackingPoint?{x:this.trackingPoint.x,z:this.trackingPoint.z}:null,
      latency:this.stats.latencyMs,stats:{...this.stats},safety:this.safetyReason,
      resources:this.resources.status,checks:this.checks,evaluated:this.evaluated};
  }
  controlPreview() {
    if(!this.plan?.route||this.lastTime==null||this.plan.escape)return null;
    const s=this.observer.lastProjection?.s??this.plan.route.start;
    const points=[];
    for(let d=-8;d<=128;d+=8)points.push([d,this.plan.route.at(s+d).offset]);
    return {s,time:this.lastTime,points};
  }
}
