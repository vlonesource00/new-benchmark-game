// Offline proposals are isolated from the game. A real-vehicle probe must accept a candidate before it ships.
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { Course } from '../src/course.js';
import config from '../config.json' with {type:'json'};
import { writeFileSync,mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args=process.argv.slice(2),arg=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1];};
const trackId=arg('track','harbor-ring'),cls=arg('cls','lmdh'),iterations=+arg('iterations',3000),seed=+arg('seed',23),
  track=new Track(trackId),car=new Vehicle(0,'ICP','#fc4',cls),course=new Course(track,{...config,...config.tracks?.[trackId],...config.tracks?.[trackId]?.perClass?.[cls]});
course.prepare(car);course.model.grip=1;course.model.margin=.99;
const before=course.line.speeds(course.model,{brakeExp:course.options.brakeExp,mass:car.spec.mass+30});
const after=course.line.optimise(course.model,{iterations,seed,brakeExp:course.options.brakeExp,mass:car.spec.mass+30});
const candidate={...course.line.toJSON(),reference:'APEX measured geometry; INTERCEPT whole-lap perturbation',version:1,seed,iterations,qss:after};
const dir=fileURLToPath(new URL('../results/',import.meta.url));mkdirSync(dir,{recursive:true});writeFileSync(dir+`course-${trackId}-${cls}-${seed}.json`,JSON.stringify({[trackId]:{[cls]:candidate}}));
console.log(JSON.stringify({track:trackId,cls,seed,iterations,before,after,improvement:before-after,file:`course-${trackId}-${cls}-${seed}.json`}));
