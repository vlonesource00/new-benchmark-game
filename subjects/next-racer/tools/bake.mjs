// Offline immutable geometry only. Live tyre, fuel, traffic and weather
// envelopes are still recomputed by each driver from native public state.
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { Road } from '../src/road.js';
import config from '../config.json' with {type:'json'};
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
const a=process.argv.slice(2),get=(k,d)=>a.find(x=>x.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const file=get('options-file',null),o=file?JSON.parse(readFileSync(file,'utf8')):{};
const path={...config.path,...o.path},classes=get('classes','gt,lmdh').split(','),tracks=get('tracks','harbor-ring').split(',');
const out=get('out','subjects/next-racer/data/lines.json');
const data=a.includes('--append')?JSON.parse(readFileSync(out,'utf8')):{version:1,lines:[]};
for(const id of tracks)for(const classId of classes){
  const track=new Track(id),car=new Vehicle('bake','bake','#fff',classId);car.fuel=35;
  const road=new Road(track,{...path,car,unbaked:true});
  data.lines=data.lines.filter(line=>line.key!==road.geometryKey);
  data.lines.push({key:road.geometryKey,estimatedLapTime:road.estimatedLapTime,offsets:Array.from(road.q)});
  console.log(JSON.stringify({id,classId,n:road.n,estimatedLapTime:road.estimatedLapTime,geometryKey:road.geometryKey}));
}
mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(data)+'\n');
