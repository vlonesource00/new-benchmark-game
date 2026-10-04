import { PitLane, PitAutopilot } from '../../../game/core/pit.js';
import { RacingLine } from '../../../game/engine/sim/ai.js';
import { ForceControl } from './control.js';
import { clamp } from './math.js';

// A seat worker's shared Track has no host pit geometry. Own that geometry on
// a view so native surface/wall queries agree without changing legacy seats.
// Live wetness, ambient and rubber continue to come from the shared track.
export function drivingTrack(track,count) {
  const view=Object.create(track),lane=new PitLane(view,count);
  return {track:view,lane};
}

export class PitGuide {
  constructor(track,road,car,count,policy,lane) {
    this.track=track;this.road=road;
    this.lane=lane;this.line=new RacingLine(track,car.spec);
    this.pilot=new PitAutopilot(this.lane,this.lane.boxes[Math.min(car.id,count-1)],this.line);
    this.control=new ForceControl(track,road,{...policy,execution:'force',
      lookahead:.7,minLook:9,maxLook:26,brakeFloor:6,axleBrake:false,
      courseProjection:false,arcLook:false,
      warmForceTransition:false,warmCornerGripUse:null});
    this.control.point=s=>this.point(s);
  }
  point(s) {
    const qAt=s=>{
      const l=this.lane,g=this.pilot,d=l.d(s,l.entry),a=l.d(l.approach,l.entry);
      // A lookahead can already be inside the lane while the car is still
      // approaching. Wrapped distance there is almost a full lap; treating
      // it as the pre-approach blends the path back onto the racing line.
      if(g.phase==='approach'&&l.inLane(s))return l.laneAt(s);
      if(g.phase==='approach'&&d>a){
        const u=clamp((a+120-d)/120,0,1),blend=u*u*(3-2*u);
        return this.road.at(s).offset*(1-blend)+this.line.offsetAt(s)*blend;
      }
      return g.targetLat(s);
    };
    const a=this.track.at(s-4,qAt(s-4)),b=this.track.at(s,qAt(s)),c=this.track.at(s+4,qAt(s+4));
    const ax=b.x-a.x,az=b.z-a.z,bx=c.x-b.x,bz=c.z-b.z;
    const den=Math.hypot(ax,az)*Math.hypot(bx,bz)*Math.hypot(ax+bx,az+bz);
    return {...b,offset:qAt(s),heading:Math.atan2(c.x-a.x,c.z-a.z),
      curvature:den>1e-7?2*(az*bx-ax*bz)/den:0};
  }
  update(car,p,state) {
    const l=this.lane,window=l.inWindow(p.s,(l.approach-120+l.L)%l.L,(l.entry+40)%l.L);
    const release=state.pit==='release'||car.race?.pitLap&&Math.abs(p.lateral)>this.track.halfWidth-1&&
      (l.inWindow(p.s,l.exit,l.handover)||l.inLane(p.s)&&l.d(l.entry,p.s)>40);
    if(!release&&!window)return null;
    if(!release&&!state.pitPlan&&!state.pit)return null;
    this.pilot.phase=release?'release':'approach';this.pilot.track=this.track;
    const speed=this.pilot.targetSpeed(p.s,car);
    const factor=this.track.id==='harbor-ring'&&state.weather==='clear'?1:.92;
    return this.control.control(car,p,{forceGuard:1},speed*factor);
  }
}
