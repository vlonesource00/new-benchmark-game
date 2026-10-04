import { Road } from './road.js';
import { ForceControl } from './control.js';
import { Observer } from './observation.js';
import { Episodes } from './episode.js';
import { Resources } from './resources.js';
import { generateRoutes,refugeRoutes } from './routes.js';
import { choosePlan } from './search.js';
import { guardControls,reverseSpace } from './safety.js';
import { escapePrefix,escapeControl,actuationState,validatePrefix } from './plant.js';
import { PitGuide,drivingTrack } from './pit.js';
import { angle, clamp } from './math.js';

const clock=()=>globalThis.performance?.now?.()??Date.now();
export class SpearheadDriver {
  constructor(track,options={}) {
    this.track=track;this.o=options;
    this.observer=new Observer(track);this.episodes=new Episodes(track,options);this.resources=new Resources(track);
    this.stats={updates:0,plans:0,rollouts:0,latencyMs:0,maxLatencyMs:0,emergencies:0,passes:0};
    this.epoch=0;this.reset();
  }
  reset() {
    this.epoch++;this.nextPlan=-Infinity;this.nextEnvelope=-Infinity;
    this.observer.reset();this.episodes.reset();this.resources.reset();
    this.plan=null;this.selected=null;this.stalled=0;this.reverseUntil=-Infinity;
    this.lifecycle='INIT';this.lastState=null;this.lastTime=null;this.checks=[];
    this.targetSpeed=0;this.trackingPoint=null;this.safetyReason=null;
    this.steerOrigin=null;this.controlPeriod=1/120;
    this.executionPreview=null;this.executionControls=null;
  }
  prepare(car,count=1) {
    if(this.road)return;
    const start=clock();
    const environment=drivingTrack(this.track,count);
    this.road=new Road(environment.track,{...this.o.path,car});
    const physical={...this.o.policy,warmForceTransition:false,
      ...(car.classId==='lmdh'?{cornerGripUse:.88,warmCornerGripUse:.84,previewBrake:12}:{previewBrake:8}),
      ...this.o.physical};
    this.control=new ForceControl(environment.track,this.road,physical);
    this.validator=new ForceControl(environment.track,this.road,physical);
    this.road.rebuildEnvelope(car,this.control.o.gripUse);
    this.pitGuide=new PitGuide(environment.track,this.road,car,count,this.control.o,environment.lane);
    this.stats.initMs=clock()-start;
  }
  update(car,cars,dt,context={}) {
    const start=clock();this.prepare(car,cars.length);
    const state=context.state??{},obs={...this.observer.observe(car,cars,context,dt,this.road),
      executionPreview:this.executionPreview,executionControls:this.executionControls},p=obs.projection;
    this.stats.observerMs=clock()-start;this.stats.envelopeMs=0;this.stats.searchMs=0;
    this.stats.routesMs=0;this.stats.admissionMs=0;
    const lifecycle=car.race?.finishTime!=null?'FINISHED':state.phase==='countdown'?'PRIME':
      state.formation?'FORMATION_PREVIEW':state.pit?'PIT_'+state.pit.toUpperCase():
      state.session==='qualifying'?((car.race?.progress??0)<0?'QUALIFY_OUT':'QUALIFY_PUSH'):'RACE';
    if(this.lifecycle!==lifecycle) {
      this.nextPlan=-Infinity;this.plan=null;
      if(this.lifecycle==='FORMATION_PREVIEW'||lifecycle.startsWith('PIT_'))this.episodes.resetBattle();
    }
    this.lifecycle=lifecycle;this.lastState=state;this.lastTime=obs.time;
    const resource=this.resources.update(car,obs,{...state,totalLaps:context.totalLaps??state.totalLaps});
    this.lastResource=resource;
    if(obs.time>=this.nextEnvelope){
      const envelopeStart=clock();
      const wet=clamp(((this.track.wetness??0)-.08)/.14,0,1),grip=this.control.o.gripUse;
      this.road.rebuildEnvelope(car,grip+(Math.min(grip,.86)-grip)*wet);
      this.plan?.route.refresh();
      this.nextEnvelope=obs.time+1/(this.o.envelopeHz??2);
      this.stats.envelopeMs=clock()-envelopeStart;
    }
    const forbidden=lifecycle==='FINISHED'||state.formation||state.phase==='countdown'||state.session==='qualifying'
      ||state.flag==='yellow'||state.flag==='red'||state.flag==='blue';
    const episode=this.episodes.update(car,obs,forbidden,{road:this.road,factor:resource.factor});
    const application=actuationState(car,obs,this.control);
    const pit=this.pitGuide.update(application.car,application.projection,state);
    if(lifecycle==='PRIME'||lifecycle==='FORMATION_PREVIEW'){
      // Native formation holds the field and overwrites these pedals. Warm
      // observation/force feedback here without solving imaginary battles
      // against the held grid. Green triggers a fresh admitted race plan.
      car.controls=this.control.control(car,p,{hold:p.lateral,dt:context.feedbackPeriod??dt,
        factor:resource.factor,forceGuard:1},Math.max(30,car.speed));
      this.targetSpeed=this.control.targetSpeed;this.trackingPoint=this.control.lastTarget;
      this.selected={kind:'formation',side:0};this.plan=null;
    }
    else if(pit) {car.controls=pit;this.trackingPoint=this.pitGuide.control.lastTarget;
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
          const searchStart=clock();
          const nominalPoint=this.road.at(p.s);
          const departure=(car.x-nominalPoint.x)*Math.cos(nominalPoint.heading)
            -(car.z-nominalPoint.z)*Math.sin(nominalPoint.heading);
          const previous=this.plan?.route;
          const battleHorizon=typeof this.o.maneuverHorizon==='number'?this.o.maneuverHorizon:
            this.o.maneuverHorizon?.[car.classId];
          const settings={...this.o,horizon:episode.target?(battleHorizon??this.o.horizon??2.4):this.o.horizon??2.4};
          let result=null;
          // Carry an admitted pullout through the next snapshots. It is
          // checked afresh with current forces and traffic; alternative
          // generation resumes on a veto or after this short commitment.
          if(this.o.commitSeconds&&episode.role==='attack'&&episode.locked&&previous
            &&!['free','follow','join'].includes(previous.kind)&&!previous.kind.startsWith('emergency-')
            &&this.plan.target===episode.target?.id&&this.plan.episode===episode.id
            &&obs.time-previous.created<this.o.commitSeconds){
            previous.refresh();
            const native=validatePrefix(car,obs,previous,this.validator,
              {...resource,trafficHorizon:this.o.trafficHorizon},settings.horizon);
            if(native.feasible)result={route:previous,native,checks:[{kind:previous.kind,side:previous.side,...native,traces:undefined}]};
          }
          if(!result){
          const routesStart=clock();
          const routes=generateRoutes(this.road,car,obs,this.o.maneuvers===false?{role:'pace',target:null}:episode,this.o);
          if(this.o.maneuvers!==false&&previous&&previous.kind!=='free'&&previous.kind!=='follow'
            &&this.plan.target===episode.target?.id&&episode.target&&this.plan.role===episode.role
            &&this.plan.episode===episode.id
            &&(episode.stage!=='Alongside'||previous.side===episode.side)
            &&obs.time-previous.created<7){
            // Re-evaluate the committed geometry with current tyre/force data.
            // Retention never reuses an old speed envelope or skips a veto.
            previous.refresh();routes.push(previous);previous.continuation=true;
          }
          // The maneuver ablation keeps native admission, brake actions and
          // recovery. Only tactical geometry is disabled; removing safety too
          // confounded the comparison with a different clear-track controller.
          for(const route of routes)route.retainLane=this.o.retainOverlapLane!==false;
          this.stats.routesMs=clock()-routesStart;
          const admissionStart=clock();
          result=this.o.nativeAdmission===false?{route:routes[0],checks:[],evaluated:[]}:
            choosePlan(this.road,car,obs,routes,episode,resource,this.validator,settings);
          this.stats.admissionMs=clock()-admissionStart;
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
            const escapes=[];
            for(const route of refugeRoutes(this.road,car,obs,routes[0])){
              route.retainLane=this.o.retainOverlapLane!==false;
              const escape=escapePrefix(car,obs,this.validator,{...resource,defending:episode.role==='defend'},route);
              escapes.push({route,escape});
              if(escape.feasible&&escape.action.factor===1)break;
            }
            escapes.sort((a,b)=>Number(b.escape.feasible)-Number(a.escape.feasible)
              ||b.escape.score-a.escape.score);
            const {route:refuge,escape}=escapes[0];
            this.plan={route:refuge,target:episode.target?.id??null,role:episode.role,episode:episode.id,
              created:obs.time,epoch:this.epoch,validUntil:obs.time+.2};
            this.plan.escape=escape;
            this.selected={kind:refuge.kind==='emergency-hold'?'emergency-hold':'emergency-join',side:refuge.side};
            this.stats.emergencies++;
          }
          }else{
            this.plan.native=result.native;this.checks=result.checks;this.evaluated=[];
            this.stats.plans++;this.stats.rollouts++;
          }
          const stableAir=this.o.freeAirHz&&!episode.target
            &&obs.rivals.every(r=>Math.abs(r.gap)>Math.max(50,car.speed*.8))&&this.plan?.route.kind==='free'
            &&Math.abs(departure)<.6&&Math.abs(angle(Math.atan2(car.vx,car.vz)-nominalPoint.heading))<.08;
          this.nextPlan=obs.time+1/(stableAir?this.o.freeAirHz:this.o.planHz??6);
          this.stats.searchMs=clock()-searchStart;
        }
        const route=this.plan.route;
        const commandCar=application.car,commandProjection=application.projection;
        this.steerOrigin=commandCar.controls.steer;
        this.controlPeriod=Math.max(1/120,Math.min(.2,(obs.context.feedbackPeriod??obs.elapsed)||1/30));
        const nominal=this.control.control(commandCar,commandProjection,{route,factor:resource.factor*(this.plan.factor??.9),rotation:resource.rotation,
          dt:this.controlPeriod,
          push:resource.push,cornerUse:resource.cornerUse,
          brakeAction:this.plan.brakeAction??true,
          forceGuard:clamp((obs.elapsed-.025)/.015,0,1)},
          obs.time+application.lag<route.created+(route.yieldFor??0)?route.yieldSpeed:Infinity);
        const command=this.plan.escape?escapeControl(commandCar,commandProjection,this.control,resource,route,this.plan.escape.action,this.controlPeriod):nominal;
        const safe=guardControls(car,cars,this.track,command,{route});
        car.controls=safe.controls;
        this.safetyReason=this.plan.escape?(this.plan.escape.feasible?'validated-escape':'best-effort-escape'):safe.reason;
        this.targetSpeed=this.control.targetSpeed;this.trackingPoint=this.control.lastTarget;
      }
    }
    this.stats.updates++;this.stats.passes=this.episodes.completed;
    this.stats.latencyMs=clock()-start;this.stats.maxLatencyMs=Math.max(this.stats.maxLatencyMs,this.stats.latencyMs);
    this.executionControls={...car.controls};
    return car.controls;
  }
  debug() {
    return {architecture:'SPEARHEAD',intent:this.lifecycle==='RACE'?this.episodes.role.toUpperCase():this.lifecycle,
      stage:this.episodes.stage,target:this.episodes.target,side:this.episodes.side,
      targetSpeed:this.targetSpeed,plan:this.selected,epoch:this.epoch,
      control:(this.selected?.kind==='pit'?this.pitGuide?.control:this.control)?.lastSignal??null,
      trackingPoint:this.trackingPoint?{x:this.trackingPoint.x,z:this.trackingPoint.z}:null,
      latency:this.stats.latencyMs,stats:{...this.stats},safety:this.safetyReason,
      resources:this.resources.status,checks:this.checks,evaluated:this.evaluated};
  }
  controlPreview() {
    if(!this.plan?.route||this.lastTime==null||!['RACE','QUALIFY_OUT','QUALIFY_PUSH'].includes(this.lifecycle)){
      this.executionPreview=null;return null;
    }
    const s=this.observer.lastProjection?.s??this.plan.route.start;
    const points=[],course=[],route=this.plan.route,escape=this.plan.escape?.action;
    if(!escape)for(let d=-8;d<=128;d+=8)points.push([d,route.at(s+d).offset]);
    // Serialize on the planner's own grid. A moving four-metre grid used to
    // re-interpolate the course every reply, changing its curvature/speed
    // profile under the executor even when the selected route stayed fixed.
    // Course projection searches 36 m behind the hint. Include its entire
    // support instead of clipping it at the preview's old 20 m rear edge.
    const step=this.road.step,start=(Math.floor(s/step)-Math.ceil(48/step))*step;
    for(let station=start;station<=s+360+step;station+=step){
      const p=route.at(station);course.push([station-s,p.x,p.z,p.heading,p.curvature,p.speed,p.offset,p.metric]);
    }
    const preview={s,time:this.lastTime,points,course,policy:{...this.control.o},retainLane:route.retainLane,
      steerOrigin:this.steerOrigin,controlPeriod:this.controlPeriod,
      factor:(this.lastResource?.factor??1)*(escape?.factor??this.plan.factor??1),
      rotation:this.lastResource?.rotation??0,push:this.lastResource?.push??false,
      cornerUse:this.lastResource?.cornerUse,lookahead:escape?.lookahead,
      steerBias:escape?.bias??0,brakeMin:escape?.brake??0,
      brakeAction:escape?true:this.plan.brakeAction??true,
      yieldUntil:route.created+(route.yieldFor??0),yieldSpeed:route.yieldSpeed??0};
    this.executionPreview=preview;return preview;
  }
}
