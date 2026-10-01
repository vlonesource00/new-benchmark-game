import { pathCurvature } from './path-geometry.js';

function equalArc(points,step=.5){
  const distances=[0];
  for(let i=1;i<=points.length;i++)distances.push(distances.at(-1)+Math.hypot(points[i%points.length].x-points[i-1].x,points[i%points.length].z-points[i-1].z));
  const length=distances.at(-1),count=Math.ceil(length/step),result=[];let j=1;
  for(let i=0;i<count;i++){
    const d=i*length/count;while(j<distances.length-1&&distances[j]<d)j++;
    const a=points[j-1],b=points[j%points.length],u=(d-distances[j-1])/(distances[j]-distances[j-1]);
    result.push({...a,x:a.x+(b.x-a.x)*u,z:a.z+(b.z-a.z)*u});
  }
  return result;
}

// Closed-lap time objective. The envelope is supplied by the car's existing
// model; this module cannot grant power, grip or braking force.
export function lapTimeProfile(points,envelope,{ceiling=78,skill=.956,passes=8,wheelbase=2.7,steeringRate=1.2}={}){
  points=equalArc(points);
  const n=points.length,speed=new Float64Array(n),distance=new Float64Array(n),curvature=new Float64Array(n);
  for(let i=0;i<n;i++){
    const a=points[(i+n-4)%n],b=points[i],c=points[(i+4)%n],next=points[(i+1)%n];
    curvature[i]=pathCurvature(a,b,c);distance[i]=Math.hypot(next.x-b.x,next.z-b.z);
    let lo=1,hi=ceiling;
    for(let j=0;j<16;j++){
      const v=(lo+hi)/2;
      if(v*v*Math.abs(curvature[i])<=envelope(v,b).lateral*skill*skill)lo=v;else hi=v;
    }
    speed[i]=lo;
  }
  for(let i=0;i<n;i++){
    const j=(i+1)%n,change=Math.abs(Math.atan(curvature[j]*wheelbase)-Math.atan(curvature[i]*wheelbase));
    const limit=steeringRate*distance[i]/Math.max(1e-9,change);
    speed[i]=Math.min(speed[i],limit);speed[j]=Math.min(speed[j],limit);
  }
  const acceleration=(i,v,kind)=>{
    const e=envelope(v,points[i]);
    const utilization=Math.min(.999,v*v*Math.abs(curvature[i])/Math.max(1,e.lateral));
    return Math.max(0,e[kind]*Math.sqrt(1-utilization*utilization));
  };
  for(let pass=0;pass<passes;pass++){
    for(let i=n-1;i>=0;i--){
      const j=(i+1)%n,v=speed[j];
      speed[i]=Math.min(speed[i],Math.sqrt(v*v+2*acceleration(j,v,'brake')*distance[i]));
    }
    for(let i=0;i<n;i++){
      const j=(i+n-1)%n,v=speed[j];
      speed[i]=Math.min(speed[i],Math.sqrt(v*v+2*acceleration(j,v,'drive')*distance[j]));
    }
  }
  let seconds=0,maxSteeringRate=0;
  for(let i=0;i<n;i++){
    const j=(i+1)%n,dt=2*distance[i]/Math.max(.1,speed[i]+speed[j]);seconds+=dt;
    maxSteeringRate=Math.max(maxSteeringRate,Math.abs(Math.atan(curvature[j]*wheelbase)-Math.atan(curvature[i]*wheelbase))/Math.max(.001,dt));
  }
  return {seconds,speed,distance,curvature,maxSteeringRate};
}

// Smooth compact basis updates couple entry, apex and exit rather than moving
// one apex in isolation. Only a lower physically constrained lap time wins.
export function optimizeLapOffsets(track,initial,envelope,{limit=track.halfWidth-1.5,sweeps=2,widths=[80,40,20],amplitudes=[.6,.3,.15]}={}){
  const nodes=track.nodes,n=nodes.length,offsets=Float64Array.from(initial);
  const point=(i,q)=>({...track.at(nodes[i].s,q),offset:q});
  const fine=[];
  let index=0;
  for(let s=0;s<track.length;s+=1){
    while(index<n-1&&nodes[index+1].s<=s)index++;
    const j=(index+1)%n,span=(nodes[j].s-nodes[index].s+track.length)%track.length;
    fine.push({s,i:index,j,u:(s-nodes[index].s)/span,p:track.at(s)});
  }
  const evaluate=control=>lapTimeProfile(fine.map(({s,i,j,u,p})=>{
    const offset=control[i].offset+(control[j].offset-control[i].offset)*u;
    // Test fixtures may supply only world points; real road frames are exact.
    if(!Number.isFinite(p.nx))return track.at(s,offset);
    return {x:p.x+p.nx*offset,z:p.z+p.nz*offset,s,offset};
  }),envelope);
  let points=nodes.map((_,i)=>point(i,offsets[i]));
  let profile=evaluate(points),accepted=0;
  const initialSeconds=profile.seconds;
  const stationGap=(a,b)=>((a-b+track.length*1.5)%track.length)-track.length*.5;
  for(let scale=0;scale<widths.length;scale++)for(let sweep=0;sweep<sweeps;sweep++){
    const width=widths[scale],amplitude=amplitudes[scale];
    for(let center=0;center<n;center+=2){
      const affected=[];
      for(let i=0;i<n;i++){
        const u=Math.abs(stationGap(nodes[i].s,nodes[center].s))/width;
        if(u<1)affected.push({i,basis:(1-u*u)**3,old:offsets[i]});
      }
      let winner=null;
      for(const sign of [-1,1]){
        const candidate=points.slice();let legal=true;
        for(const {i,basis,old} of affected){
          const q=old+sign*amplitude*basis;
          if(Math.abs(q)>limit){legal=false;break;}candidate[i]=point(i,q);
        }
        if(!legal)continue;
        const next=evaluate(candidate);
        // Prevent time optimization from purchasing unrealizable steering jumps.
        if(next.maxSteeringRate>1.2+1e-6)continue;
        if(next.seconds<profile.seconds-1e-5&&(!winner||next.seconds<winner.profile.seconds))winner={sign,points:candidate,profile:next};
      }
      if(winner){
        for(const {i,basis,old} of affected)offsets[i]=old+winner.sign*amplitude*basis;
        points=winner.points;profile=winner.profile;accepted++;
      }
    }
  }
  return {offsets,points,profile,initialSeconds,accepted};
}
