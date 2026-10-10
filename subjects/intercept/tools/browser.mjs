// Real Chromium module workers. INTERCEPT_PLAYWRIGHT can point to an installed Playwright ESM entry.
import { pathToFileURL } from 'node:url';
const pw=process.env.INTERCEPT_PLAYWRIGHT?await import(pathToFileURL(process.env.INTERCEPT_PLAYWRIGHT).href):await import('playwright');
const args=process.argv.slice(2),arg=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1];};
const browser=await pw.chromium.launch({headless:true,...(process.env.INTERCEPT_CHROME?{executablePath:process.env.INTERCEPT_CHROME}:{})});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(arg('url','http://127.0.0.1:4179/'),{waitUntil:'domcontentloaded'});
 const result=await page.evaluate(async({duration,steps,delay,cls,debug})=>{
  const [{Track},{EnduranceRace,FIXED_DT},{FORMATS},{AsyncSeats}]=await Promise.all([import('/engine/sim/track.js'),import('/core/race.js'),import('/core/rules.js'),import('/core/async-seats.js')]);
  // Delay only INTERCEPT step replies. Other drivers retain their own normal worker cadence.
  const WorkerOriginal=globalThis.Worker;
  if(delay){globalThis.Worker=class extends WorkerOriginal{
    set onmessage(callback){super.onmessage=e=>{if(e.data?.type==='controls'&&e.data.preview?.version===1)setTimeout(()=>callback(e),delay);else callback(e);};}
  };}
  const teams=Array.from({length:2},(_,i)=>({id:'b'+i,name:'ICP'+i,short:'IC'+i,index:i,grid:i,color:'#fc4',classId:cls,starter:0,
    drivers:[{id:'intercept',kind:'ai',name:'INTERCEPT',short:'ICP'}]}));
  const track=new Track('harbor-ring'),seats=new AsyncSeats('harbor-ring'),race=new EnduranceRace({track,teams,format:{...FORMATS.custom,mandatoryStops:0,mandatorySwap:false},laps:20,
    startCompound:'soft',startType:'rolling',difficulty:1,makeBridge:seats.factory(),seed:7});
  seats.wantDebug=debug;seats.lensIndex=0;await seats.start(race);
  for(const e of race.entries)e.strategist.decide=()=>null;for(const c of race.cars)race.fitTyres(c,'soft',true);race.start();
  const begin=performance.now(),cost=[],frames=[];let previous=begin;
  await new Promise(resolve=>{const run=()=>{const now=performance.now();frames.push(now-previous);previous=now;
    const start=performance.now();for(let i=0;i<steps&&race.time<duration;i++)race.step(FIXED_DT);cost.push(performance.now()-start);
    if(race.time>=duration){resolve();return;}requestAnimationFrame(run);};requestAnimationFrame(run);});
  const quantile=(a,p)=>[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*p))];
  const result={cls,delay,debug,steps,time:race.time,wall:performance.now()-begin,workers:seats.hosts.length,failed:seats.hosts.some(h=>h.failed),contacts:race.contacts,severe:race.collisionStats.severeContacts,
    cars:race.cars.map((c,i)=>({best:c.race.bestLap,damage:c.damage,inc:race.stewards.of(race.entries[i]).inc,errors:race.entries[i].bridges[0].errors,
      debug:race.entries[i].bridges[0].debug(),latency:race.entries[i].bridges[0].lastLatency})),frameP95:quantile(frames,.95),physicsFrameP95:quantile(cost,.95)};
  seats.dispose();globalThis.Worker=WorkerOriginal;return result;
 },{duration:+arg('time',120),steps:+arg('steps',24),delay:+arg('delay',0),cls:arg('cls','lmdh'),debug:args.includes('--debug')});
 console.log(JSON.stringify({...result,errors,cars:result.cars.map(c=>({...c,debug:{intent:c.debug.intent,stats:c.debug.stats,planAge:c.debug.planAge,trace:c.debug.trace}}))}));
}finally{await browser.close();}
