import { Track } from '../../../host/astra/src/sim/track.js';
import { Session } from '../../../host/astra/src/sim/session.js';
import { loadGhost } from '../src/ghost-store.js';
import { PhantomDriver } from '../src/phantom-driver.js';
const track=new Track('harbor-ring');const s=new Session(track,{classId:'gt'});s.mode='practice';s.field=1;s.autopilot=true;s.start({freshTrack:true});
let t=Date.now();const g=await loadGhost(track,s.player);console.log('ghost',Date.now()-t,'ms',g.lapTime);
s.drivers[0]=new PhantomDriver({track,ghost:g});s.phase='racing';s.countdown=0;
for(let i=0;i<Number(process.argv[2]??40);i++){t=Date.now();s.step(1/120,{});const dt=Date.now()-t;if(dt>30||i%10===0)console.log(i,dt,'ms v',s.player.speed.toFixed(2),'thr',s.player.controls.throttle.toFixed(2),'lat',s.player.lateral.toFixed(2));}
