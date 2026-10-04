import { geometry, speedEnvelope } from './road.js';
import { clamp, angle, distance, wrap } from './math.js';
import { forecast } from './observation.js';
import { projectCourse,advanceCourse,geometryCourse } from './course.js';
import { fairCorridor } from './corridor.js';
import { bodyHalf } from './safety.js';

const smooth = t => { t = clamp(t,0,1); return t*t*t*(10 + t*(-15 + 6*t)); };
function smoothBound(x,bound,width){
  if(width<=0)return clamp(x,-bound,bound);
  const min=(a,b)=>Math.min(a,b)-width*Math.max(0,1-Math.abs(a-b)/width)**3/6;
  return min(-min(-x,bound),bound);
}
function transferLength(road,car,delta,initialCurvature,minimum=28){
  const table=road.table,u=clamp(car.speed/table.step,0,table.nv-1),i=Math.min(table.nv-2,Math.floor(u));
  const lateral=table.lateral[i]+(table.lateral[i+1]-table.lateral[i])*(u-i);
  const reserve=Math.max(3,lateral*.58-car.speed**2*Math.abs(initialCurvature));
  // Peak second derivative of a quintic lateral transfer is 5.77*delta/L².
  // Asking for a shorter move made the force controller brake to achieve it.
  return clamp(Math.sqrt(5.8*Math.abs(delta)*car.speed**2/reserve),minimum,125);
}
// Quintic Hermite with a measured starting course and zero endpoint slope.
function interpolate(a,b,d) {
  const h=b.d-a.d, t=clamp((d-a.d)/Math.max(1,h),0,1), v=b.q-a.q, m=(a.slope??0)*h, n=(b.slope??0)*h;
  return a.q + m*t + (10*v-6*m-4*n)*t**3 + (-15*v+8*m+7*n)*t**4 + (6*v-3*m-3*n)*t**5;
}

export class Route {
  constructor(road, car, obs, description) {
    Object.assign(this,description);
    this.road=road; this.start=obs.projection.s; this.created=obs.time;
    this.length=description.length; this.q=new Float32Array(road.q);
    const course=car.speed>3?Math.atan2(car.vx,car.vz):car.yaw;
    const slope=clamp(Math.tan(angle(course-obs.projection.heading)),-.6,.6);
    this.knots=[{d:0,q:obs.projection.lateral,slope},...description.knots];
    if(description.corridor){
      this.corridorOrigin=this.preferred(road.sample(road.q,this.start));
      this.corridorSlope=(this.preferred(road.sample(road.q,this.start+1))
        -this.preferred(road.sample(road.q,this.start-1)))*.5;
    }
    if((description.kind==='free'&&!description.world)||description.nominal){
      this.geometry=road.geometry;this.speed=road.speed;
      this.key=description.kind+':'+(description.yieldSpeed??0);return;
    }
    if(description.field){
      const initial=description.field(0),gradient=(description.field(1)-description.field(-1))*.5;
      const transfer=description.transfer;
      for(let i=0;i<road.n;i++){
        const d=distance(i*road.step,this.start,road.length);
        if(d<0&&d>-90)this.q[i]+= (obs.projection.lateral-road.q[i])*smooth((d+90)/90);
        if(d<0||d>this.length)continue;
        const t=clamp(d/transfer,0,1),position=1-10*t**3+15*t**4-6*t**5,
          velocity=t-6*t**3+8*t**4-3*t**5;
        this.q[i]=description.field(d)+(this.knots[0].q-initial)*position
          +(slope-gradient)*transfer*velocity;
      }
      if(description.fair)this.q=fairCorridor(road,this.q,{start:this.start,length:this.length,
        transfer,side:description.side,field:description.field});
      this.geometry=geometry(road.base,this.q,road.curvatureSpan);
      this.speed=speedEnvelope(this.geometry,road.table,road.gripUse,
        road.gripRatios(this.q,this.geometry),road.liveBrakeReserve).speed;
      this.key=description.kind+':'+description.side+':'+description.lane.toFixed(2);
      return;
    }
    if(description.world){
      const f=road.at(this.start),dx=car.x-f.x,dz=car.z-f.z;
      this.knots[0]={d:0,q:dx*Math.cos(f.heading)-dz*Math.sin(f.heading),
        slope:clamp(Math.tan(angle(course-f.heading)),-.6,.6)};
      const longitudinal=dx*Math.sin(f.heading)+dz*Math.cos(f.heading);
      const points=road.points.map((p,i)=>{
        const d=distance(i*road.step,this.start,road.length),h=p.heading;
        if(d>this.length||d<=-90)return {x:p.x,z:p.z,nx:0,nz:0};
        let offset=0,lead=0;
        if(d>=0&&d<=this.length){offset=this.offset(d);lead=longitudinal*(1-smooth(d/60));}
        else if(d<0&&d>-90)offset=this.knots[0].q*smooth((d+90)/90);
        let x=p.x+Math.cos(h)*offset+Math.sin(h)*lead,
          z=p.z-Math.sin(h)*offset+Math.cos(h)*lead;
        const near=road.track.nearest(x,z),edge=road.track.halfWidth-car.spec.halfWidth-.4;
        const rounding=(description.roundWorld??0)*smooth(Math.max(0,d)/35);
        if(Math.abs(near.lateral)>edge-rounding){
          const legal=road.track.at(near.s,smoothBound(near.lateral,edge,rounding));x=legal.x;z=legal.z;
        }
        this.q[i]=road.track.nearest(x,z).lateral;
        return {x,z,nx:0,nz:0};
      });
      this.geometry=geometry(points,new Float32Array(road.n),Math.min(2,road.curvatureSpan));
      this.speed=speedEnvelope(this.geometry,road.table,road.gripUse,
        road.gripRatios(this.q,this.geometry),road.liveBrakeReserve).speed;
      this.key=description.kind+':'+description.side+':'+description.lane.toFixed(2);
      return;
    }
    for(let i=0;i<road.n;i++) {
      const d=distance(i*road.step,this.start,road.length);
      if(d>=0 && d<=this.length) this.q[i]=description.kind==='free'
        ? road.q[i]
        : description.corridor ? this.corridorOffset(d,road.q[i])
        : this.offset(d);
      else if(description.kind!=='free' && d<0 && d>-90) this.q[i]=road.q[i]+(obs.projection.lateral-road.q[i])*smooth((d+90)/90);
    }
    this.geometry=geometry(road.base,this.q,road.curvatureSpan);
    this.speed=speedEnvelope(this.geometry,road.table,road.gripUse,
      road.gripRatios(this.q,this.geometry),road.liveBrakeReserve).speed;
    this.key=description.kind+':'+description.side+':'+description.lane.toFixed(2);
  }
  preferred(base) {
    const width=1,h=Math.max(0,1-Math.abs(base-this.lane)/width),round=width*h*h*h/6;
    // Round toward the free side so smoothing cannot cross the occupied
    // corridor boundary. Hard max/min joints introduced artificial curvature
    // and forced braking while a car carried a perfectly usable side lane.
    return this.side>0?Math.max(base,this.lane)+round:Math.min(base,this.lane)-round;
  }
  corridorOffset(d,base) {
    const transfer=this.knots[1].d,hold=this.knots[2].d;
    const preferred=this.preferred(base);
    if(d<transfer){
      const t=clamp(d/transfer,0,1),position=1-10*t**3+15*t**4-6*t**5,
        velocity=t-6*t**3+8*t**4-3*t**5;
      return preferred+(this.knots[0].q-this.corridorOrigin)*position
        +(this.knots[0].slope-this.corridorSlope)*transfer*velocity;
    }
    if(d<hold)return preferred;
    return preferred+(base-preferred)*smooth((d-hold)/Math.max(1,this.length-hold));
  }
  offset(d) {
    const k=this.knots;
    if(d<=0)return k[0].q;
    for(let i=1;i<k.length;i++)if(d<=k[i].d)return interpolate(k[i-1],k[i],d);
    return k.at(-1).q;
  }
  at(s) {
    const r=this.road,g=this.geometry,p=wrap(s,r.length)/r.step,i=Math.floor(p),j=(i+1)%r.n,t=p-i;
    const h=g.heading[i]+angle(g.heading[j]-g.heading[i])*t,base=r.track.at(s);
    return { ...base, x:r.sample(g.x,s),z:r.sample(g.z,s),heading:angle(h),
      offset:r.sample(this.q,s),curvature:r.sample(g.curvature,s),speed:r.sample(this.speed,s),
      metric:Math.max(.2,r.sample(g.ds,s)/r.step) };
  }
  refresh() {
    const r=this.road;
    if(this.envelopeVersion===r.envelopeVersion)return this;
    if(this.kind==='free'&&!this.world){this.speed=r.speed;this.envelopeVersion=r.envelopeVersion;return this;}
    this.speed=speedEnvelope(this.geometry,r.table,r.gripUse,
      r.gripRatios(this.q,this.geometry),r.liveBrakeReserve).speed;
    this.envelopeVersion=r.envelopeVersion;
    return this;
  }
  project(x,z,hint){return projectCourse(geometryCourse(this.geometry,this.road.step,this.road.length),x,z,hint);}
  advance(s,metres){return advanceCourse(geometryCourse(this.geometry,this.road.step,this.road.length),s,metres);}
}

export function cornerGate(track,s,reach=400) {
  let best=null;
  for(let d=20;d<=reach;d+=8) {
    const k=track.at(s+d).curvature;
    if(Math.abs(k)>.004 && (!best || Math.abs(k)>Math.abs(best.curvature)))best={d,s:s+d,curvature:k,inside:Math.sign(k)};
  }
  return best ? {...best,exit:Math.min(reach,best.d+65)} : {d:reach*.5,s:s+reach*.5,curvature:0,inside:0,exit:reach*.7};
}

// An emergency return to the fastest line can sweep across a car that is
// already alongside. Keep the occupied lane available as a feedback refuge;
// each alternative still needs the same native body and road validation.
export function refugeRoutes(road,car,obs,nominal) {
  const edge=road.track.halfWidth-car.spec.halfWidth-.4,
    lane=clamp(obs.projection.lateral,-edge,edge),length=Math.max(180,car.speed*4);
  return [nominal,...[0,-1.2,1.2].map(delta=>{
    const q=clamp(lane+delta,-edge,edge);
    return new Route(road,car,obs,{kind:'emergency-hold',side:Math.sign(delta),lane:q,
      length,gate:nominal.gate,knots:[{d:Math.max(18,car.speed*.7),q},
        {d:length-55,q},{d:length,q:road.at(obs.projection.s+length).offset}]});
  })];
}

export function generateRoutes(road,car,obs,episode,options={}) {
  const p=obs.projection,r=episode.target,edge=road.track.halfWidth-car.spec.halfWidth-.4;
  const length=clamp(car.speed*7+60,240,500),gate=cornerGate(road.track,p.s,length-70);
  const candidates=[];
  const add=(kind,side,lane,transfer,holdTo,extra={})=>{
    const reach=extra.length??length;
    lane=clamp(lane,-edge,edge); transfer=clamp(transfer,12,reach-100);
    holdTo=clamp(holdTo,transfer+20,reach-55);
    candidates.push(new Route(road,car,obs,{kind,side,lane,length:reach,gate,corridor:true,...extra,knots:[
      {d:transfer,q:lane},{d:holdTo,q:lane},{d:reach,q:road.at(p.s+reach).offset}
    ]}));
  };
  // Keep a nominal continuation and a smooth return as separate choices.
  // Always forcing a new return curve would slow ordinary tracking errors.
  const base=road.at(p.s),departure=(car.x-base.x)*Math.cos(base.heading)
    -(car.z-base.z)*Math.sin(base.heading);
  const course=car.speed>3?Math.atan2(car.vx,car.vz):car.yaw;
  const needsJoin=Math.abs(departure)>.8||Math.abs(angle(course-base.heading))>.18;
  const join=transferLength(road,car,departure,base.curvature,35);
  const free=new Route(road,car,obs,{kind:'free',side:0,lane:0,length,gate,knots:[
      {d:Math.min(90,length*.3),q:road.at(p.s+Math.min(90,length*.3)).offset},
      {d:length,q:road.at(p.s+length).offset}
    ]});
  candidates.push(free);
  if(needsJoin)candidates.push(new Route(road,car,obs,{kind:'join',side:0,lane:0,length,gate,
    world:true,knots:[{d:join,q:0},{d:length,q:0}]}));
  if(!r)return candidates;
  const catching=Math.max(1,car.speed-r.speed),approach=(r.gap-car.spec.halfLength-r.halfLength)/catching;
  if(options.reachableApproach===false&&options.approachSeconds&&episode.role==='attack'&&episode.stage==='Prepare'
    &&r.gap>35&&approach>options.approachSeconds)return candidates;
  if(episode.role==='defend')for(const delta of [7,10]){
    // If staying outside would destroy the corner exit, briefly let a much
    // faster rival clear the crossing, then take the full-speed exit. This is
    // a time-bounded concession, never braking to block its nose.
    const side=Math.sign(p.lateral-r.q)||1,reach=Math.max(110,car.speed*2.8);
    candidates.push(new Route(road,car,obs,{kind:'yield-cutback',side,lane:side*1.2,
      world:true,length:reach,gate,yieldFor:1.8,yieldSpeed:Math.max(12,car.speed-delta),knots:[
        {d:24,q:side*1.2},{d:reach-65,q:side*1.2},{d:reach,q:0}]}));
  }
  // Keep the nominal continuation available. Body validation decides when
  // it is safe to return; overlap does not mandate a slow side corridor.
  const alongside=episode.stage==='Alongside'||episode.stage==='Clear';
  // Approach with room to pull out. Once overlap is established, a second
  // wide pullout tightens the inside radius and spends the available drive
  // force on steering. Offer a closer corridor using both rotated bodies;
  // every course still passes the native traffic and road admission checks.
  const occupiedWidth=bodyHalf(car,p.heading).width+bodyHalf({yaw:r.yaw,
    spec:{halfWidth:r.halfWidth,halfLength:r.halfLength}},p.heading).width;
  const separation=episode.role==='attack'&&alongside&&options.alongsideMargin!=null
    ?occupiedWidth+options.alongsideMargin:car.spec.halfWidth+r.halfWidth+(options.passMargin??.55);
  const closing=Math.max(2,car.speed-r.speed);
  const ttc=Math.max(0,(r.gap-car.spec.halfLength-r.halfLength)/closing);
  const predicted=forecast(road.track,r,Math.min(2,ttc));
  const transfer=alongside?clamp(car.speed*.45,12,24):clamp(Math.max(32,car.speed*.9),32,100);
  const holdTo=Math.max(gate.exit,Math.max(70,r.gap+car.speed*2.5));
  // Reserve the side lane until the rear bumper can clear. A short candidate
  // that returns before that point creates an attractive fictitious pass and
  // then forces braking beside the rival as its return approaches.
  const clearTravel=episode.role==='attack'&&r.gap>-(car.spec.halfLength+r.halfLength+2)
    ?car.speed*(r.gap+car.spec.halfLength+r.halfLength+2)/Math.max(1,car.speed-r.speed):0;
  const availableSides=alongside||episode.locked ? [episode.side||Math.sign(p.lateral-r.q)||1]
    : episode.role==='defend'&&episode.covered ? [episode.side||Math.sign(p.lateral-r.q)||1] : [-1,1];
  for(const side of availableSides) {
    if(options.spaceTimeRoutes)for(const scale of [.9,1.1]){
      const width=separation+.1,long=car.spec.halfLength+r.halfLength+2;
      const field=d=>{
        const base=road.at(p.s+d).offset;
        if(d<0||d>length)return base;
        const speed=Math.max(12,(car.speed+road.at(p.s+d*.5).speed)*.5);
        const t=Math.max(0,d/speed)*scale,f=forecast(road.track,r,Math.min(6.6,t));
        const gap=distance(f.s,p.s+d,road.length),padding=Math.max(22,speed*.7);
        const weight=smooth((long+padding-Math.abs(gap))/padding);
        const boundary=f.q+side*width;
        const lane=side>0?Math.max(base,boundary):Math.min(base,boundary);
        return clamp(base+(lane-base)*weight,-edge,edge);
      };
      const q=field(Math.min(80,car.speed*1.1));
      const change=transferLength(road,car,q-p.lateral,base.curvature,alongside?18:35);
      candidates.push(new Route(road,car,obs,{kind:episode.role==='defend'?'space-time-cover':'space-time-pass',
        side,lane:q,length,gate,field,transfer:change,knots:[]}));
      if(options.fairCorridors&&scale===.9)candidates.push(new Route(road,car,obs,
        {kind:episode.role==='defend'?'flow-cover':'flow-pass',side,lane:q,length,gate,
          field,transfer:change,fair:true,knots:[]}));
    }
    const referenceQ=alongside?(side>0?Math.max(r.q,predicted.q):Math.min(r.q,predicted.q)):predicted.q;
    const lane=referenceQ+side*separation;
    const rivalBase=road.at(r.s),rivalOffset=(r.x-rivalBase.x)*Math.cos(rivalBase.heading)
      -(r.z-rivalBase.z)*Math.sin(rivalBase.heading);
    const worldLane=clamp(rivalOffset+side*separation,-5,5);
    const ownBase=road.at(p.s),ownWorld=(car.x-ownBase.x)*Math.cos(ownBase.heading)
      -(car.z-ownBase.z)*Math.sin(ownBase.heading);
    const worldReach=options.clearanceHorizon
      ?[...new Set([clamp(clearTravel+85,190,length),clamp(clearTravel+155,270,length),length])]
      :[190,270,length];
    for(const reach of options.worldRoutes===false?[]:worldReach){
      const change=transferLength(road,car,worldLane-ownWorld,ownBase.curvature,alongside?12:28);
      candidates.push(new Route(road,car,obs,{kind:episode.role==='defend'?'world-carry':'world-pass',
        side,lane:worldLane,length:reach,gate,world:true,roundWorld:options.roundWorld,knots:[
          {d:change,q:worldLane},{d:reach-70,q:worldLane},{d:reach,q:0}
        ]}));
    }
    if(Math.abs(lane)>edge+.05)continue;
    if(episode.role==='defend') {
      // One modest cover before overlap. Leave the other car a full width,
      // and preserve an exit rather than aiming to stop at its nose.
      const cover=clamp(gate.inside*2.5,-edge,edge);
      if(!alongside&&!episode.covered && -r.gap/Math.max(1,r.speed-car.speed)>2)
        add('cover',side,cover,Math.max(65,transfer),gate.exit,{defend:true});
      const legalTransfer=transferLength(road,car,lane-p.lateral,ownBase.curvature,alongside?12:28);
      add('carry',side,lane,legalTransfer,holdTo,{defend:true});
      const relative=Math.max(2,Math.abs(r.speed-car.speed)),clearance=car.spec.halfLength+r.halfLength+4,
        separating=r.gap*(r.speed-car.speed)>0,
        remaining=separating?Math.max(0,clearance-Math.abs(r.gap)):clearance+Math.abs(r.gap),
        clearDistance=clamp(car.speed*remaining/relative,legalTransfer+30,length-80);
      add('carry-release',side,lane,legalTransfer,clearDistance,{defend:true,length:Math.min(length,clearDistance+75)});
    } else {
      const legalTransfer=transferLength(road,car,lane-p.lateral,ownBase.curvature,alongside?12:28);
      add(gate.inside===side?'inside-exit':gate.inside?'outside-carry':'pullout',side,lane,legalTransfer,holdTo);
      add('parallel',side,lane,legalTransfer*.85,holdTo);
      if(!alongside){
        // Pass on the approach, then reach the next corner in a usable exit
        // position. Keeping a side corridor through an unrelated corner can
        // needlessly price an otherwise easy pass out of the search.
        const returns=options.clearanceHorizon
          ?[...new Set([clamp(clearTravel+85,190,length),clamp(clearTravel+155,270,length),360])]
          :[190,270,360];
        for(const reach of returns){
          if(reach>=length)continue;
          if(options.clearanceHorizon&&reach<clearTravel+70)continue;
          add('pass-return',side,lane,Math.max(30,transfer*.7),reach-70,{length:reach});
        }
      }
      // Delayed approach and opposite exit are different orderings of gates.
      // They are useful when a lead car closes the first inside.
      if(gate.inside && !alongside && ttc>1.2) {
        const first=clamp(r.q-side*.5,-edge,edge),entry=Math.max(transfer,gate.d-25);
        const exit=Math.min(length-70,Math.max(entry+50,gate.exit));
        candidates.push(new Route(road,car,obs,{kind:'cutback',side,lane,length,gate,
          knots:[{d:entry,q:first},{d:exit,q:lane},{d:length,q:road.at(p.s+length).offset}]}));
      }
    }
  }
  if(!alongside&&episode.role==='attack') { const follow=new Route(road,car,obs,{kind:'follow',side:0,lane:r.q,length,gate,
    knots:[{d:Math.max(70,transfer),q:r.q},{d:length,q:road.at(p.s+length).offset}]});
    candidates.push(follow); }
  if(!candidates.length)candidates.push(free);
  return candidates;
}
