// Read-only planner telemetry; station alignment separates motion from replanning.
export function describePlan(plan,car,model){
  const points=plan?.points??[];
  if(!points.length)return null;
  const apex=points.reduce((a,b)=>b.speedLimit<a.speedLimit?b:a);
  const curvaturePeak=points.reduce((a,b)=>Math.abs(b.curvature)>Math.abs(a.curvature)?b:a);
  const e=model.at(car.speed,car.s,car.lateral);
  const brakeDistance=Math.max(0,(car.speed**2-apex.speedLimit**2)/(2*Math.max(1,e.brake)));
  return {startS:plan.startS,apexS:apex.s,targetApexSpeed:apex.speedLimit,
    brakeStartS:apex.s-brakeDistance,peakDecel:e.brake,curvaturePeakS:curvaturePeak.s,
    peakCurvature:curvaturePeak.curvature,points:points.map(p=>({s:p.s,curvature:p.curvature,speedLimit:p.speedLimit,offset:p.offset}))};
}
