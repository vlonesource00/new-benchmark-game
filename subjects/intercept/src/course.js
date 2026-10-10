import { Line } from '../../apex/src/line.js';
import { CarModel, liveGrip } from '../../apex/src/model.js';
import lines from '../../apex/data/lines.json' with { type: 'json' };
import ownCourses from '../data/courses.json' with {type:'json'};
import { tyreWet } from '../../../game/engine/sim/water.js';
import { clamp, angle, join, ease, gap } from './math.js';

/** Course geometry uses the measured APEX reference; profiles and all mutable arrays are private. */
export class Course {
  constructor(track, options) { this.track = track; this.options = options; this.clock = 99; this.pool = []; }
  prepare(car) {
    if (this.line && this.classId === car.classId) return;
    this.classId = car.classId; const baked = this.options.courses?.[this.track.id]?.[car.classId] ?? ownCourses[this.track.id]?.[car.classId] ?? lines[this.track.id]?.[car.classId];
    this.model = new CarModel(car.classId);
    this.model.margin = this.options.margin; this.model.jerk = this.options.jerk;
    this.line = new Line(this.track, { ds: baked?.ds ?? 3, edge: -.55 });
    if (!this.line.load(baked ? { ds:baked.ds,px:baked.px,pz:baked.pz } : null)) { this.line.seed(500); this.line.optimise(this.model,{iterations:2000,seed:7}); }
    this.refresh(car, true);
    this.pool = Array.from({length:this.options.maxCandidates},() => {const path=this.line.blankLane();path.st=this.line.st.slice();return {path,window:null};});
  }
  grip(car) {
    return liveGrip(car).grip * (1 - .36*tyreWet(this.track,car)) * (this.track.tempGrip ?? 1);
  }
  refresh(car, force = false, allowance = 1) {
    const g = this.grip(car), m = this.options.margin*allowance;
    if (!force && Math.abs(g-this.model.grip)<.007 && Math.abs(m-this.model.margin)<.004) return;
    this.model.grip = g; this.model.margin = m;
    const o = {mass:car.spec.mass+car.fuel*.75,brakeExp:this.options.brakeExp};
    if (force) { this.estimate = this.line.speeds(this.model,o); return; }
    if (this.rebuild) return;
    const shadow = Object.create(this.line);
    for (const k of ['v','vmax','vbrk','vfree','cap']) shadow[k] = this.line[k].slice();
    shadow.kept = [...this.line.kept];
    this.rebuild = {shadow,gen:shadow.speedsGen(this.model,o)};
  }
  tick(car, dt, allowance=1) {
    this.clock += dt;
    if (this.clock>.25) { this.clock=0; this.refresh(car,false,allowance); }
    if (!this.rebuild) return;
    for(let n=0;n<2;n++) { const r=this.rebuild.gen.next(); if(!r.done) continue;
      const {shadow}=this.rebuild; for(const k of ['v','vmax','vbrk','vfree','cap']) this.line[k].set(shadow[k]);
      this.line.kept=shadow.kept; this.estimate=r.value; this.rebuild=null; break;
    }
  }
  /** Connected offset corridor with a C2 join from the body's actual course, not a teleport to a lane. */
  beginRoutes(...paths) { this.reserved = new Set(paths.filter(Boolean)); }
  corridor(car, target, side, slot=0, {entry=55,hold=120,returnLength=80,clearance=this.options.separation,jerk=this.options.steerJerk,joinSpeed=car.speed}={}) {
    const base=this.line, cur=base.closest(car.x,car.z), i0=cur.i, d0=cur.e;
    const beta=Math.atan2(car.v,Math.max(2,car.u)), slope=clamp(Math.tan(angle(car.yaw+beta-base.heading(cur.i,cur.f))),-.35,.35);
    const second=clamp((car.yawRate/Math.max(8,car.speed)-base.ks[i0]),-.004,.004);
    const rivalIndex=target ? (target.reference?.i??base.closest(target.car.x,target.car.z).i) : i0;
    const offset=target ? (target.offset??target.d-base.lat[rivalIndex])+side*clearance : side*clearance;
    // A quintic displacement's peak lateral jerk is 60*delta*v^3/L^3. An undersized join
    // creates an artificial low-speed notch; choose its physical length before compiling.
    entry=Math.max(entry,joinSpeed*Math.cbrt(60*Math.max(.1,Math.abs(offset-d0))/Math.max(20,jerk))*1.08);
    const reach=entry+hold+returnLength, n=Math.min(base.N-22,Math.ceil(reach/base.ds));
    const shift=new Float64Array(n+1), bound=this.track.halfWidth-1.12;
    // Smooth the admissible hold route itself before joining. Pointwise hard clipping is not a path join.
    const offsets=new Float64Array(n+1);
    for(let j=0;j<=n;j++) { const i=base.idx(i0+j);offsets[j]=clamp(base.lat[i]+offset,-bound,bound)-base.lat[i]; }
    for(let pass=0;pass<3;pass++) { const copy=offsets.slice(); for(let j=1;j<n;j++) offsets[j]=(copy[j-1]+2*copy[j]+copy[j+1])*.25; }
    for(let j=0;j<=n;j++) { const x=j*base.ds;
      shift[j]=x<entry ? join(d0,slope,second,offsets[j],entry,x) : x<entry+hold ? offsets[j] : offsets[j]*(1-ease((x-entry-hold)/returnLength));
    }
    // Candidate compilation must not mutate the active lane before its replacement is accepted.
    let pool;
    for(let n=0;n<this.pool.length;n++){const candidate=this.pool[(slot+n)%this.pool.length];
      if(!this.reserved?.has(candidate.path)){pool=candidate;break;}}
    if(!pool)throw Error('INTERCEPT corridor budget exhausted');
    this.reserved?.add(pool.path);
    if(pool.window) for(const key of ['px','pz','len','h','k','ks','dk','lat','vmax','v','vbrk','st']) for(let j=-14;j<=pool.window.n+16;j++) {const i=base.idx(pool.window.i0+j);pool.path[key][i]=base[key][i];}
    const path=base.laneWindow(shift,i0,n,pool.path);pool.window={i0,n};
    path.entryLength=entry;path.targetOffset=target?.offset??target?.d;path.steerJerk=jerk;path.clearance=clearance;
    for(let j=-8;j<=n;j++){const i=base.idx(i0+j),q=this.track.nearest(path.px[i],path.pz[i]);path.st[i]=q.s;path.lat[i]=q.lateral;}
    path.holdEndS=path.st[base.idx(i0+Math.min(n,Math.ceil((entry+hold)/base.ds)))];
    path.speedsWindow(this.model,i0,n,95,base.vbrk[base.idx(i0+n)],{mass:car.spec.mass+car.fuel*.75,brakeExp:this.options.brakeExp,jerk,notch:false,vbrkEnd:base.vbrk[base.idx(i0+n)]});
    path.key=`${target?.id??'space'}:${side}`;
    return path;
  }
  /** Bounded wire representation: only the executable local window, no live/shared buffers. */
  contract(path, car, battle, now, epoch=0, sequence=0) {
    const c=path.closest(car.x,car.z), count=Math.min(path.N-1,Math.ceil(Math.max(360,car.speed*5)/path.ds)), arrays={};
    for(const key of ['px','pz','h','ks','lat','vbrk','vmax','len','st']) arrays[key]=Array.from({length:count+1},(_,j)=>path[key][path.idx(c.i-3+j)]);
    return {version:1,epoch,sequence,time:now,track:this.track.id,classId:car.classId,ds:path.ds,sourceS:path.st[path.idx(c.i-3)],
      endS:path.st[path.idx(c.i-3+count)],arrays,battle:{...battle},steerJerk:path.steerJerk??this.options.steerJerk,model:{grip:this.model.grip,margin:this.model.margin},key:path.key??'course'};
  }
}

/** Open local route. Advancing past its endpoint hands back to the already loaded base course. */
export class Route {
  constructor(contract) {
    Object.assign(this,contract.arrays); this.N=this.px.length;this.ds=contract.ds;this.key=contract.key;this.contract=contract;this.steerJerk=contract.steerJerk; this.v=this.vbrk;
  }
  idx(i){return Math.max(0,Math.min(this.N-1,i));}
  closest(x,z,hint=-1){
    let best=Infinity,bi=0;const start=hint<0?0:Math.max(0,hint-6),end=hint<0?this.N-2:Math.min(this.N-2,hint+16);
    for(let i=start;i<=end;i++){const ux=this.px[i+1]-this.px[i],uz=this.pz[i+1]-this.pz[i],q=ux*ux+uz*uz;
      const f=clamp(((x-this.px[i])*ux+(z-this.pz[i])*uz)/Math.max(q,1e-8),0,1),dx=x-this.px[i]-ux*f,dz=z-this.pz[i]-uz*f,d2=dx*dx+dz*dz;
      if(d2<best){best=d2;bi=i;this.found={i,f,e:(dx*uz-dz*ux)/Math.max(1e-4,Math.sqrt(q)),d2};}}
    return this.found;
  }
  sample(a,i,f,ahead=0){let d=f*this.len[i]+ahead;while(i<this.N-2&&d>=this.len[i]){d-=this.len[i];i++;}while(i>0&&d<0){i--;d+=this.len[i];}const u=clamp(d/Math.max(.01,this.len[i]),0,1);return a[i]*(1-u)+a[this.idx(i+1)]*u;}
  heading(i,f){return this.h[i]+angle(this.h[this.idx(i+1)]-this.h[i])*f;}
  valid(car,track){const distance=gap(track.nearest(car.x,car.z).s,this.contract.sourceS,track.length),extent=gap(this.contract.endS,this.contract.sourceS,track.length);
    return distance>=-6&&distance<Math.max(40,extent-25);}
}
