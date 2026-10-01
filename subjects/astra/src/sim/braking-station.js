// Convert a physical braking distance into the selected path's road station.
// A tight inside trajectory can be materially shorter than the road centreline.
export function brakingStation(plan,apex,distance){
  if(apex.travelDistance===undefined||plan.startS===undefined)return apex.s-distance;
  const target=apex.travelDistance-distance;
  let prior={distance:0,travelDistance:0};
  for(const point of plan.points){
    if(point.travelDistance===undefined)continue;
    if(point.travelDistance>=target){
      const span=point.travelDistance-prior.travelDistance;
      if(span<=1e-9)continue;
      return plan.startS+prior.distance+(target-prior.travelDistance)*(point.distance-prior.distance)/span;
    }
    prior=point;
  }
  return apex.s-distance;
}
