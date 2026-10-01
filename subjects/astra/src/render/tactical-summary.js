// Read-only presentation: +lateral projects to driver-left in Astra's +Z-forward
// Three.js camera. Never flip the physical planner's coordinates to fix a label.
export const driverSide=side=>side>0?'Left':side<0?'Right':'Centre';
export const diagramX=(lateral,scale=8)=>110-lateral*scale;

export function cornerContext(track,s,speed=30){
  if(!track?.at)return {sign:0,label:'Turn data unavailable',inside:'—',outside:'—',distance:null,apexS:null};
  const horizon=Math.max(100,Math.min(180,speed*4));
  const points=[];
  for(let distance=0;distance<=horizon;distance+=5){
    const a=track.at(s+distance-8),b=track.at(s+distance+8);
    const turn=Math.atan2(Math.sin(b.heading-a.heading),Math.cos(b.heading-a.heading));
    points.push({distance,s:s+distance,curvature:turn/16});
  }
  const first=points.find(p=>Math.abs(p.curvature)>.003);
  if(!first)return {sign:0,label:'Straight',inside:'—',outside:'—',distance:null,apexS:null};
  const sign=Math.sign(first.curvature);
  const segment=points.filter(p=>p.distance>=first.distance);
  const end=segment.findIndex((p,i)=>i>0&&p.curvature*sign<-.003);
  const turn=segment.slice(0,end<0?segment.length:end);
  const apex=turn.reduce((best,p)=>Math.abs(p.curvature)>Math.abs(best.curvature)?p:best,first);
  return {sign,label:`${driverSide(sign)} turn${end>=0?' · linked change of direction':''}`,
    inside:driverSide(sign),outside:driverSide(-sign),distance:first.distance,apexS:apex.s};
}

const duration=(plan,distance)=>{
  let a={distance:0,time:0};
  for(const b of plan.points){
    if(b.distance>=distance){const f=(distance-a.distance)/Math.max(.001,b.distance-a.distance);return a.time+(b.time-a.time)*f;}
    a=b;
  }
  return a.time;
};

export function tacticalSummary(planner,car){
  const selected=planner.plan,plans=[...new Set([selected,...planner.candidates])].filter(p=>p.points?.length);
  const corner=cornerContext(planner.line?.track,planner.observation.origin.s,car.speed);
  const distance=Math.min(...plans.map(p=>p.points.at(-1).distance));
  const reference=plans.reduce((best,p)=>Math.abs(p.endExtra)<Math.abs(best.endExtra)?p:best,selected);
  const target=planner.observation.observations.find(o=>o.id===planner.targetId);
  const name=plan=>{
    if(plan.manoeuvre==='SWITCHBACK'&&planner.targetId!==null)return 'Switchback';
    const side=driverSide(Math.sign(plan.endExtra));
    const position=corner.sign&&Math.abs(plan.endExtra)>.5?(plan.endExtra*corner.sign>0?'Inside':'Outside'):side;
    if(planner.intent==='DEFEND')return `${position} cover`;
    if(planner.intent==='SIDE_BY_SIDE')return `Hold ${side.toLowerCase()} corridor`;
    if(planner.intent==='ATTACK')return `${position} attack${plan.manoeuvre==='PASS THEN EXIT'?' → exit':''}`;
    return Math.abs(plan.endExtra)<.5?'Racing line':`${side} corridor`;
  };
  const forecast=plan=>{
    const exit=plan.points.at(-1);let conflict=0,pass=null,exitAdvantage=null,exitSpeedAdvantage=null;
    for(const other of planner.observation.observations){
      let peak=0;
      for(const point of plan.points){
        const branches=planner.perception.responses?.(other,point.time,planner.line)??[];
        const total=branches.reduce((sum,p)=>sum+p.probability,0);
        const overlap=branches.filter(p=>Math.abs(p.distance-point.distance)<other.halfLength+2.3&&Math.abs(p.lateral-point.offset)<other.halfWidth+.99)
          .reduce((sum,p)=>sum+p.probability,0);
        peak=Math.max(peak,total?overlap/total:0);
      }
      conflict=Math.max(conflict,peak);
      if(other.id===target?.id){
        const branches=planner.perception.responses?.(other,exit.time,planner.line)??[],total=branches.reduce((sum,p)=>sum+p.probability,0);
        pass=total?branches.filter(p=>exit.distance-p.distance>other.halfLength+2.3).reduce((sum,p)=>sum+p.probability,0)/total:null;
        const predicted=planner.perception.predict(other,exit.time);
        exitAdvantage=exit.distance-predicted.distance;exitSpeedAdvantage=(exit.speed-predicted.speed)*3.6;
      }
    }
    const components=[['contact risk','contactCost'],['grip demand','gripCost'],['traffic delay','trafficCost'],['commitment to the current side','intentCost'],['rival response risk','responseRisk']];
    const excess=components.map(([label,key])=>({label,value:(plan[key]??0)-(selected[key]??0)})).sort((a,b)=>b.value-a.value)[0];
    let reason=plan.hardConflict?'Predicted body overlap exceeds the accepted contact limits':excess?.value>.1?`Higher ${excess.label}`:'Lower total value after time, exit position and commitment';
    if(plan===selected){
      reason=planner.intent==='ATTACK'&&target?exitAdvantage>4.6?`Projected to clear ${target.name} by ${exitAdvantage.toFixed(1)} m at the exit`:`Keep pressure on ${target.name}; the pass is not yet secured`:
        planner.intent==='DEFEND'&&target?`Hold a committed corridor against ${target.name}; preserve ${Math.round(exit.speed*3.6)} km/h at the exit`:
        planner.intent==='SIDE_BY_SIDE'?'Hold the occupied corridor through the corner; do not cross the rival’s bodywork':
        `Lowest-scored feasible route of ${plans.length} candidates; ${Math.round(exit.speed*3.6)} km/h predicted exit`;
    }
    if(plan===selected&&plan.hardConflict)reason='Every candidate predicts conflict; controlling speed on the least-risk route';
    return {plan,name:name(plan),reason,secondsSaved:duration(reference,distance)-duration(plan,distance),
      clearance:!Number.isFinite(plan.minClearance)||plan.minClearance===99?null:plan.minClearance,conflict:planner.perception.responses?conflict:null,pass,exitAdvantage,exitSpeedAdvantage,
      exitSpeed:exit.speed*3.6};
  };
  const alternatives=[];const seen=new Set([`${selected.endExtra}/${selected.manoeuvre}`]);
  for(const plan of plans){const key=`${plan.endExtra}/${plan.manoeuvre}`;if(seen.has(key))continue;seen.add(key);alternatives.push(forecast(plan));if(alternatives.length===3)break;}
  return {selected:forecast(selected),alternatives,corner,target:target?.name??null,distance};
}
