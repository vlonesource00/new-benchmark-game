// Autonomous outcome fixtures on the unchanged benchmark plant. Rival code is
// pinned; only initial placement/skill varies. Cut-in fixtures apply a brief
// ordinary steering input to create the externally triggered hazard.
import { Track } from '../../benchmark/host/astra/src/sim/track.js';
import { RacingLine } from '../../benchmark/host/astra/src/sim/ai.js';
import { Vehicle, collisions, wakes } from '../../benchmark/host/astra/src/sim/vehicle.js';
import { AdaptiveDriver as RivalDriver } from '../../benchmark/subjects/astra/src/sim/controller.js';
import { AdaptiveDriver } from '../src/sim/controller.js';
import { relativeDistance } from '../src/sim/perception.js';
import { writeFileSync } from 'node:fs';

const fixtures=[
  {name:'slower-car-multiple-corners',s:600,duration:60,rivals:[[18,0,34,.82]]},
  {name:'inside-pass',s:680,rivals:[[14,-2.8,34,.84]]},
  {name:'outside-pass',s:680,rivals:[[14,2.8,34,.84]]},
  {name:'switchback',s:800,rivals:[[10,2.8,28,.84]]},
  {name:'side-by-side',s:600,offset:-1.2,speed:36,rivals:[[1,1.2,36,.956]]},
  {name:'inside-cover-defender',s:680,rivals:[[14,2.8,38,.92]]},
  {name:'front-target-rear-attacker',s:680,rivals:[[20,0,35,.84],[-15,-1,44,.99]]},
  {name:'three-wide',s:550,rivals:[[1,-2.5,40,.95],[1,2.5,40,.95]]},
  {name:'post-pass-retention',s:600,duration:50,rivals:[[9,0,30,.9]]},
  ...[0,5,12].map(closing=>({name:`cut-in-${closing}mps`,s:400,speed:40,cutIn:true,rivals:[[14,3.2,40-closing,.93]]})),
];
const results=[];
const selected=process.argv.find(a=>a.startsWith('--cases='))?.slice(8).split(',');
if(selected?.some(name=>!fixtures.some(f=>f.name===name)))throw new Error('Unknown racecraft fixture');
for(const fixture of fixtures.filter(f=>!selected||selected.includes(f.name))){
  const track=new Track('harbor-ring'),line=new RacingLine(track),ego=new Vehicle(0);
  ego.place(track,fixture.s,fixture.offset??0,fixture.speed??40);
  const cars=[ego,...fixture.rivals.map(([gap,offset,speed],i)=>{
    const c=new Vehicle(i+1);c.place(track,fixture.s+gap,offset,speed);return c;
  })];
  const drivers=[new AdaptiveDriver(0,line,.956,.8),...fixture.rivals.map((r,i)=>new RivalDriver(i+1,line,r[3],.8))];
  drivers.forEach(d=>d.planner.age=5);
  const stats={peakClosing:0,severeContacts:0},dt=1/120;
  const result={name:fixture.name,seconds:fixture.duration??35,blockedSeconds:0,passesAttempted:0,passesCompleted:0,
    passesRetained:0,failedAttacks:0,defenses:0,positionsGained:0,positionsLost:0,offtrack:0,severeSpins:0,
    alongsideSeconds:0,longestAlongsideSeconds:0,emergencySeconds:0,attackSeconds:0,defendSeconds:0,flanks:[]};
  const memory=fixture.rivals.map(r=>({ahead:r[0]>0,attempt:false,completed:false,retained:false,retention:0,defending:false}));
  let alongside=0,spinning=false;
  for(let tick=0;tick<result.seconds/dt;tick++){
    drivers.forEach((d,i)=>d.update(cars[i],cars,dt));
    if(fixture.cutIn&&tick*dt>.5&&tick*dt<.9)cars[1].controls={throttle:.65,brake:0,steer:-.12};
    const flow=wakes(cars);cars.forEach((c,i)=>c.step(dt,track,flow[i]));collisions(cars,stats);
    const planner=drivers[0].planner;
    if(Math.abs(ego.lateral)>track.halfWidth)result.offtrack+=dt;
    if(drivers[0].safety?.emergency)result.emergencySeconds+=dt;
    const slip=Math.abs(Math.atan2(ego.v,Math.max(.1,Math.abs(ego.u))));
    if(slip>.35&&Math.abs(ego.yawRate)>1.2&&!spinning){result.severeSpins++;spinning=true;}if(slip<.15)spinning=false;
    if(planner.intent==='ATTACK')result.attackSeconds+=dt;
    if(planner.intent==='DEFEND')result.defendSeconds+=dt;
    let beside=false,blocked=false;
    for(let i=1;i<cars.length;i++){
      const other=cars[i],m=memory[i-1],gap=relativeDistance(other.s,ego.s,track.length);
      const overlap=Math.abs(gap)<4.6;beside||=overlap;
      blocked||=gap>4.6&&gap<25&&Math.abs(other.lateral-ego.lateral)<2.5&&ego.speed<other.speed+1;
      if(m.ahead&&!m.attempt&&planner.targetId===i&&['ATTACK','SIDE_BY_SIDE'].includes(planner.intent)){
        m.attempt=true;result.passesAttempted++;
        const flank=Math.sign(ego.lateral-other.lateral)||planner.commitSide;
        if(!result.flanks.includes(flank))result.flanks.push(flank);
      }
      if(m.ahead&&gap< -5){
        m.ahead=false;m.completed=true;m.retention=0;result.passesCompleted++;result.positionsGained++;
        if(!m.attempt){m.attempt=true;result.passesAttempted++;}
      }
      if(m.completed&&!m.retained){
        m.retention=gap< -5?m.retention+dt:0;
        if(m.retention>=3){m.retained=true;result.passesRetained++;}
      }
      if(!m.ahead&&gap>5){
        m.ahead=true;result.positionsLost++;if(m.attempt){result.failedAttacks++;m.attempt=false;}
        m.completed=false;m.retained=false;m.retention=0;
      }
      if(gap> -20)m.defenseResolved=false;
      if(planner.intent==='DEFEND'&&planner.targetId===i&&!m.defenseResolved)m.defending=true;
      if(m.defending&&gap< -30){result.defenses++;m.defending=false;m.defenseResolved=true;}
      if(gap>5)m.defending=false;
    }
    if(blocked)result.blockedSeconds+=dt;
    alongside=beside?alongside+dt:0;if(beside)result.alongsideSeconds+=dt;
    result.longestAlongsideSeconds=Math.max(result.longestAlongsideSeconds,alongside);
  }
  result.unfinishedAttacks=memory.filter(m=>m.attempt&&!m.completed).length;
  result.damage=ego.damage;result.fieldDamage=cars.reduce((sum,c)=>sum+c.damage,0);Object.assign(result,stats);
  results.push(result);console.log(JSON.stringify(result));
}
const output=process.argv.find(a=>a.startsWith('--output='))?.slice(9);
if(output)writeFileSync(output,JSON.stringify({ablation:globalThis.astraAblation??null,notes:[
  'Retained means three continuous seconds fully ahead. Defended means a previously targeted pursuer dropped more than 30 m behind.',
  'Scenario names specify opportunities, not guaranteed maneuvers; observed flanks and outcomes determine success.',
  'Blocked time is an observable proximity/speed proxy, not privileged knowledge of desired free-air pace.'],results},null,2)+'\n');
