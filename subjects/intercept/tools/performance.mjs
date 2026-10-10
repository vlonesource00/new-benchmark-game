// Matched solo comparisons on every game circuit. Raw results stay beside an inspectable HTML report.
import { spawnSync,execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync,readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const args=process.argv.slice(2),arg=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1];};
const root=fileURLToPath(new URL('../../../',import.meta.url)),dir=fileURLToPath(new URL('../results/',import.meta.url));
const tracks=arg('tracks','harbor-ring,solenne,alpine,desert,nurburgring').split(','),classes=arg('classes','lmdh,gt').split(','),
  drivers=arg('drivers','intercept,razor,apex,next-racer').split(','),session=arg('session','race'),seed=+arg('seed',7),
  tyres=arg('tyres','soft'),path=arg('path','worker'),tag=arg('tag','performance-'+session),timeout=+arg('timeout',90)*1000;
if(!/^[\w-]+$/.test(tag)||tracks.some(t=>!['harbor-ring','solenne','alpine','desert','nurburgring'].includes(t)))throw Error('Invalid report name or track');
const hash=createHash('sha256');
function fingerprint(folder){for(const ent of readdirSync(root+folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
 const name=folder+'/'+ent.name;if(ent.isDirectory())fingerprint(name);else if(/\.(m?js|json)$/.test(name)){hash.update(name);hash.update(readFileSync(root+name));}
}}
for(const folder of ['subjects/intercept/src','subjects/apex/src','subjects/razor/src','subjects/next-racer/src','game/core','game/engine/sim','game/bridges'])fingerprint(folder);
hash.update(readFileSync(root+'subjects/intercept/config.json'));const source=hash.digest('hex');
let commit='unknown';try{commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();}catch{}
mkdirSync(dir,{recursive:true});const report={version:1,created:new Date().toISOString(),commit,source,session,seed,tyres,path,cases:[]};
const save=()=>writeFileSync(dir+tag+'.json',JSON.stringify(report,null,2));
for(const track of tracks)for(const cls of classes)for(const id of drivers){
 const name=`${tag}-${track}-${cls}-${id}.json`,duration=track==='nurburgring'?1400:240,start=performance.now();
 const process=spawnSync(globalThis.process.execPath,['--import','./scripts/json-loader.mjs','subjects/intercept/tools/probe.mjs',
   '--track',track,'--cls',cls,'--ids',id,'--path',path,'--tyres',tyres,'--seed',String(seed),'--session',session,'--time',String(duration),'--out',name],
   {cwd:root,encoding:'utf8',timeout,maxBuffer:2*1024*1024});
 let item={track,cls,id,file:name,wallSeconds:(performance.now()-start)/1000};
 if(process.status!==0)item.error=process.error?.code??String(process.stderr).split('\n').find(l=>/Error/.test(l))??'nonzero exit';
 else {const r=JSON.parse(readFileSync(dir+name,'utf8')).result,c=r.cars[0];
   item={...item,best:c.best,last:c.last,validLaps:c.laps.filter(l=>l.valid).length,invalidLaps:c.laps.filter(l=>!l.valid).length,
     mean:c.laps.filter(l=>l.valid).reduce((s,l)=>s+l.time,0)/Math.max(1,c.laps.filter(l=>l.valid).length),laps:c.laps,
     inc:c.inc,peakDamage:c.safety.peakDamage,errors:c.errors,wear:Math.max(...c.wear),fuel:c.fuel,cost:r.cost,
     clean:c.inc===0&&c.safety.peakDamage<1e-8&&c.errors.every(n=>n===0)&&c.best>0&&c.laps.every(l=>l.valid)};
 }
 report.cases.push(item);save();console.log(`${track} ${cls} ${id}: ${item.error??`${item.best?.toFixed(3)??'no valid lap'} s; ${item.clean?'clean':`inc ${item.inc}, invalid ${item.invalidLaps}`}`}`);
}
const data=JSON.stringify(report).replace(/</g,'\\u003c');
writeFileSync(dir+tag+'.html',`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>INTERCEPT — all-track pace</title>
<style>body{background:#111923;color:#eaf1f7;font:15px system-ui;margin:0;padding:24px;max-width:1300px}h1{font-size:25px}p{color:#aabecd}section{background:#17232e;border:1px solid #324557;border-radius:10px;padding:18px;margin:18px 0}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px;border-bottom:1px solid #324557}th{color:#aabecd}.good{color:#78dc9b}.bad{color:#ff9f85}.icp{color:#f7cf46}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#78c9ff}@media(max-width:600px){body{padding:12px}td,th{padding:7px;font-size:12px}}</style>
<h1>INTERCEPT — all-track pace</h1><p id="meta"></p><p>Matched seed, tyres, fuel setup and session; real vehicle plant and seat modules. A faster lap with incidents is not a clean win. This report measures solo pace, not passing ability or race strategy.</p><main id="cases"></main>
<script>const d=${data},names={intercept:'INTERCEPT',razor:'RAZOR',apex:'APEX','next-racer':'SPEARHEAD'},fmt=n=>Number.isFinite(n)?n.toFixed(3):'—';
document.getElementById('meta').textContent=d.session+' · '+d.tyres+' · seed '+d.seed+' · '+d.path+' · source '+d.source.slice(0,12)+' · '+d.created;
for(const track of [...new Set(d.cases.map(c=>c.track))]){const s=document.createElement('section');const h=document.createElement('h2');h.textContent=track;s.append(h);
for(const cls of ['lmdh','gt']){const cs=d.cases.filter(c=>c.track===track&&c.cls===cls);if(!cs.length)continue;const title=document.createElement('h3');title.textContent=cls==='lmdh'?'GTP':'GT3';s.append(title);const fastest=Math.min(...cs.filter(c=>c.clean).map(c=>c.best));
const t=document.createElement('table');t.innerHTML='<thead><tr><th>Driver</th><th>Best</th><th>Δ clean best</th><th>Mean</th><th>Valid/invalid laps</th><th>Incidents / peak damage</th></tr></thead>';const b=document.createElement('tbody');
for(const c of cs){const r=document.createElement('tr');const fields=[names[c.id]||c.id,c.error||fmt(c.best)+' s',c.clean?fmt(c.best-fastest)+' s':'unvalidated',fmt(c.mean)+' s',c.error?'—':c.validLaps+' / '+c.invalidLaps,c.error?'—':c.inc+' / '+(c.peakDamage*100).toFixed(2)+'%'];for(let i=0;i<fields.length;i++){const td=document.createElement('td');td.textContent=fields[i];if(i===0&&c.id==='intercept')td.className='icp';if(i===5)td.className=c.clean?'good':'bad';r.append(td);}b.append(r);}t.append(b);s.append(t);}
const details=document.createElement('details'),label=document.createElement('summary'),pre=document.createElement('pre');label.textContent='Lap and evidence data';pre.textContent=JSON.stringify(d.cases.filter(c=>c.track===track),null,2);details.append(label,pre);s.append(details);document.getElementById('cases').append(s);}</script></html>`);
console.log(`Report: ${tag}.html (${report.cases.filter(c=>c.clean).length}/${report.cases.length} clean cases)`);
