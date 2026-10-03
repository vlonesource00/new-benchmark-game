// A pass count alone is not evidence of tactical ability. Paired controls-only
// runs keep the rival, tyres, class, cadence, resources and traffic guard fixed.
// The ablation disables maneuver generation; it does not remove the opponent.
import { runEncounter,scenarios,sourceHashes } from './combat.mjs';
import { mkdirSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const cleanPass=r=>r.passHeld&&r.passedAt!=null&&!r.contactSteps&&!r.offtrackSeconds
  &&!r.rivalOfftrackSeconds&&!r.stopped&&!r.bridgeErrors&&(r.wheelExcursion??0)<=.08;
export function attribute(combat,nominal) {
  const move=combat.maneuverEvidence;
  const moved=move.maneuverSeconds>=.15&&move.overlapDeparture>.8
    &&move.firstMove!=null&&move.firstAlongside!=null&&move.firstMove<=move.firstAlongside+.2;
  const gain=nominal.passedAt!=null&&combat.passedAt!=null?nominal.passedAt-combat.passedAt:null;
  const nominalPassingFault=nominal.passedAt!=null&&(
    nominal.events?.some(e=>e.t<=nominal.passedAt+1e-6)
    ||nominal.firstOfftrack!=null&&nominal.firstOfftrack<=nominal.passedAt
    ||nominal.firstWheelExcursion!=null&&nominal.firstWheelExcursion<=nominal.passedAt);
  const verdict=!cleanPass(combat)?'no clean held pass':!moved?'normal-trajectory pass':
    nominal.passedAt==null?'maneuver enables pass':
    nominalPassingFault?'maneuver enables clean pass':
    !cleanPass(nominal)?'move made; nominal also passes but its run is unsafe':
    gain>=.5?'maneuver accelerates pass':'move made; no demonstrated advantage';
  return {verdict,moved,advantageSeconds:gain};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
const args=process.argv.slice(2),get=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const classId=get('class','lmdh'),hz=Number(get('hz',30)),seconds=Number(get('seconds',16)),filter=get('filter',null);
const delayFrames=Number(get('delay-frames',0)),burstMs=Number(get('burst-ms',0));
const round=x=>x==null?null:Math.round(x*100)/100;
const rows=[];
for(const setup of scenarios(classId).filter(s=>s.gap>0&&(!filter||s.name.includes(filter)))) {
  const timing={classId,hz,seconds,delayFrames,burstMs,trace:true};
  const combat=runEncounter(setup,timing);
  const nominal=runEncounter(setup,{...timing,maneuvers:false});
  const move=combat.maneuverEvidence;
  const {verdict,advantageSeconds:gain}=attribute(combat,nominal);
  rows.push({name:setup.name,verdict,combatTime:round(combat.passedAt),normalTime:round(nominal.passedAt),
    advantageSeconds:round(gain),departureAtOverlap:round(move.overlapDeparture),
    maneuverSeconds:round(move.maneuverSeconds),combatClean:cleanPass(combat),normalClean:cleanPass(nominal),
    combatContacts:combat.contactSteps,normalContacts:nominal.contactSteps,
    combatProgress:round(combat.progress),normalProgress:round(nominal.progress),combat,nominal});
}
const result={classId,hz,seconds,delayFrames,burstMs,sourceHashes,method:'same rival policy and traffic guard; no maneuver search in the ablation',rows};
const out=get('out',`subjects/next-racer/results/attribution-${classId}.json`);
mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,sourceHashes:undefined,rows:rows.map(({combat,nominal,...r})=>r)}));
}
