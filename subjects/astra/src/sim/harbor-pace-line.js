import { racingArc } from './racing-arc.js';
import { offsetLine, roundedLine } from './local-line.js';

const cache=new WeakMap();

// Canonical-replay geometry. Compact edits keep neighbouring complexes fixed;
// the final 10 cm inset supplies body clearance at the slow hairpin.
export function harborPaceLine(base,spec){
  if(base.track.id!=='harbor-ring'||spec.key!=='gt')return base;
  if(cache.has(base))return cache.get(base);
  let line=racingArc(base,spec,[[1210,1540],[2190,2390]]);
  line=offsetLine(line,spec,[{center:2240,width:70,amplitude:.6},{center:2340,width:70,amplitude:.3}]);
  line=roundedLine(line,spec,[[1260,1510],[2520,2700],[1520,1760]]);
  line=offsetLine(line,spec,[{center:2336,width:90,amplitude:.1}]);
  cache.set(base,line);cache.set(line,line);
  return line;
}
