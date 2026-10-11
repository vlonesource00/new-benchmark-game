import { readFileSync,writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args=process.argv.slice(2),arg=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1];};
const name=arg('case','new-pass'),reference=arg('reference','');
if(![name,reference].every(s=>/^[\w-]*$/.test(s)))throw Error('Use plain encounter names');
const dir=fileURLToPath(new URL('../results/',import.meta.url));let data=JSON.parse(readFileSync(dir+name+'.json','utf8'));
if(data.trace){
 const index=+arg('car',data.cars.findIndex(c=>c.id==='intercept')),rivalIndex=+arg('rival-car',index===0?1:0),mine=data.cars[index],other=data.cars[rivalIndex];
 if(!mine||!other||index===rivalIndex||!data.trackGeometry)throw Error('Use distinct valid car indices and regenerate this race trace with current tools');
 const source=data,green=source.trace.find(row=>!row.formation);
 data={track:source.trackGeometry,timeOrigin:0,result:{cls:mine.classId,path:source.path,rival:other.id,seed:source.seed,car:index,rivalCar:rivalIndex,
   phase:source.phase,stats:mine.outcomes,safety:mine.safety,stops:mine.stops,events:[
     {time:source.trace[0].time,type:'formation start'},...(green?[{time:green.time,type:'INTERCEPT receives control'}]:[]),
     ...source.contactEvents.filter(e=>e.a===index||e.b===index).map(e=>({time:e.time,type:(e.formation?'formation ':'')+'contact '+e.a+'/'+e.b+' at '+e.closing.toFixed(2)+' m/s'}))]},
   rows:source.trace.map(row=>{const c=row.cars[index],o=row.cars[rivalIndex];return{t:row.time,s:c.physicalRoad,x:c.x,z:c.z,yaw:c.yaw,v:c.speed,
     otherX:o.x,otherZ:o.z,otherYaw:o.yaw,gap:(o.road-c.road),controls:c.controls,damage:c.damage,visual:c.visual,
     formation:row.formation,actors:row.cars.filter(a=>a.carId!==index&&a.carId!==rivalIndex).map(a=>({carId:a.carId,id:a.id,classId:a.classId,x:a.x,z:a.z,yaw:a.yaw,speed:a.speed})),
     debug:{...c,visual:undefined,candidates:undefined,targetSpeed:c.target,route:{key:c.route},intent:row.formation?'FORMATION':c.intent},planner:c.candidates};})};
}
if(reference)data.reference=JSON.parse(readFileSync(dir+reference+'.json','utf8')).rows;
if(!data.rows?.length||!data.track?.geometry)throw Error('Regenerate this encounter with current tools first');
const encoded=JSON.stringify(data).replace(/</g,'\\u003c');
writeFileSync(dir+name+'.html',`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>INTERCEPT encounter review</title><style>*{box-sizing:border-box}body{margin:0;background:#10151c;color:#eef1f6;font:14px system-ui}main{max-width:1280px;margin:auto;padding:20px}.card{background:#19222e;border:1px solid #344153;border-radius:9px;padding:15px;margin:12px 0}button,select{background:#283241;color:white;border:1px solid #54657b;padding:7px;border-radius:4px}input[type=range]{width:100%;accent-color:#f7cf46}canvas{width:100%;height:460px;background:#111923}#plot{height:180px}pre{white-space:pre-wrap;overflow:auto;max-height:330px}p{color:#aab6c7;line-height:1.5}.row{display:flex;gap:16px;flex-wrap:wrap}b,a{color:#f7cf46}#readout{line-height:1.8}.split{display:grid;grid-template-columns:1fr 1fr;gap:15px}@media(max-width:750px){.split{grid-template-columns:1fr}main{padding:10px}canvas{height:360px}}</style>
<main><h1>INTERCEPT · encounter review</h1><p id="context"></p><div class="card"><div class="row"><button id="play">Play</button><select id="camera"><option value="body">Body view</option><option value="road">Road aligned</option><option value="pair">Pair close-up</option><option value="track">Whole track</option></select><select id="zoom"><option value=".65">Wide</option><option value="1" selected>Normal</option><option value="1.7">Close</option></select><b id="time"></b></div><input id="scrub" type="range" min="0" value="0" step="1"><canvas id="map"></canvas><p>Yellow: INTERCEPT and its executed route. Cyan: selected rival. Grey bodies: the rest of the field. Dashed grey: following-only reference, when supplied. That reference includes the rival's reactions and is a causal comparison, not a solo pace measurement. Formation is marked separately because the game's formation pilot holds the controls until green.</p></div>
<div class="card"><div id="readout"></div><canvas id="plot"></canvas><p>Yellow: speed. Cyan: requested speed. Green: throttle. Red: brake.</p></div><div class="split"><div class="card"><h2>Decision trace</h2><pre id="trace"></pre></div><div class="card"><h2>Measured outcome</h2><pre id="result"></pre><div id="events"></div></div></div></main>
<script>const D=${encoded},rows=D.rows,origin=D.timeOrigin??10,$=id=>document.getElementById(id),F=(n,p=2)=>Number.isFinite(n)?n.toFixed(p):'—';let index=0,playing=false,last=0,carry=0;
$('context').textContent=D.result.cls.toUpperCase()+' vs '+D.result.rival.toUpperCase()+' · '+D.track.id+' · '+D.result.path+' · seed '+D.result.seed+(D.result.collisionOff?' · COLLISIONS DISABLED: diagnostic only':' · normal collision physics');
$('result').textContent=JSON.stringify(D.result,null,2);$('scrub').max=rows.length-1;$('scrub').oninput=e=>{index=+e.target.value;draw()};$('camera').onchange=$('zoom').onchange=()=>draw();$('play').onclick=()=>{playing=!playing;last=0;$('play').textContent=playing?'Pause':'Play'};
for(const e of D.result.events??[]){const b=document.createElement('button');b.textContent=F(e.time-origin)+' s · '+e.type;b.onclick=()=>{index=Math.max(0,rows.findIndex(r=>r.t>=e.time));draw()};$('events').append(b);}
function canvas(id){const c=$(id),w=c.clientWidth,h=c.clientHeight,p=devicePixelRatio||1;c.width=w*p;c.height=h*p;const g=c.getContext('2d');g.scale(p,p);return{g,w,h};}
function draw(){const r=rows[index],q=r.debug??{},t=q.trace??{};$('scrub').value=index;$('time').textContent=F(r.t-origin)+' s · '+q.intent;
$('readout').textContent='Speed '+F(r.v*3.6,1)+' km/h · target '+F(q.targetSpeed*3.6,1)+' · gap '+F(r.gap)+' m · throttle '+F(r.controls.throttle*100,0)+'% · brake '+F(r.controls.brake*100,0)+'% · damage '+F(r.damage*100)+'%';
$('trace').textContent=JSON.stringify({formation:r.formation,source:t.source,pedal:t.pedal,nose:t.noseGeometry,returnNeighbor:q.returnNeighbor,trackingError:t.pathError,wake:t.wake,reserve:t.reserve,planAge:q.planAge,route:q.route,planner:r.planner,resources:q.resources,observed:q.observed},null,2);
{const{g,w,h}=canvas('map'),mode=$('camera').value,geo=D.track.geometry,road=geo.reduce((a,b)=>Math.abs(b.s-r.s)<Math.abs(a.s-r.s)?b:a),centre=mode==='pair'?{x:(r.x+r.otherX)/2,z:(r.z+r.otherZ)/2}:r,heading=mode==='body'?r.yaw:road.heading;
 const xs=geo.map(p=>p.x),zs=geo.map(p=>p.z),loX=Math.min(...xs),hiX=Math.max(...xs),loZ=Math.min(...zs),hiZ=Math.max(...zs),scale=mode==='track'?Math.min((w-50)/(hiX-loX),(h-50)/(hiZ-loZ)):h/(mode==='pair'?70:140)*+$('zoom').value;
 const point=(x,z)=>mode==='track'?{x:w/2+(x-(loX+hiX)/2)*scale,y:h/2-(z-(loZ+hiZ)/2)*scale}:{x:w/2+((x-centre.x)*Math.cos(heading)-(z-centre.z)*Math.sin(heading))*scale,y:h*.72-((x-centre.x)*Math.sin(heading)+(z-centre.z)*Math.cos(heading))*scale};
 const line=(points,color,width,dash=[])=>{if(!points.length)return;g.strokeStyle=color;g.lineWidth=width;g.setLineDash(dash);g.beginPath();points.forEach((v,i)=>{const p=point(v.x,v.z);i?g.lineTo(p.x,p.y):g.moveTo(p.x,p.y)});g.stroke();g.setLineDash([])};
 line(geo.concat(geo[0]),'#23313e',D.track.halfWidth*2*scale);line(geo.concat(geo[0]),'#465767',1,[6,5]);
 const a=Math.max(0,index-30);line(rows.slice(a,index+1),'#ad9447',1.5);line(rows.slice(a,index+1).map(x=>({x:x.otherX,z:x.otherZ})),'#337980',1.5);
 if(D.reference?.length){const ref=D.reference.filter(x=>Math.abs(x.t-r.t)<2);line(ref,'#8997a5',1.5,[5,4]);}
 line(r.visual?.selectedTrajectory?.points??[],'#f7cf46',2);
 for(const c of [...(r.actors??[]).map(c=>({...c,color:'#536475'})),{x:r.x,z:r.z,yaw:r.yaw,color:'#f7cf46'},{x:r.otherX,z:r.otherZ,yaw:r.otherYaw,color:'#51d5df'}]){const p=point(c.x,c.z),h0=mode==='track'?0:heading;g.save();g.translate(p.x,p.y);g.rotate(h0-c.yaw);g.fillStyle=c.color;g.fillRect(-.98*scale,-2.28*scale,1.96*scale,4.56*scale);g.fillStyle='#10151c';g.fillRect(-.7*scale,-1.6*scale,1.4*scale,.6*scale);g.restore();}}
 {const{g,w,h}=canvas('plot'),start=rows[0].t,span=rows.at(-1).t-start,x=t=>25+(w-45)*(t-start)/span,top=Math.max(50,...rows.map(r=>r.v));for(const[k,color]of[['v','#f7cf46'],['target','#51d5df']]){g.strokeStyle=color;g.beginPath();rows.forEach((r,i)=>{const v=k==='v'?r.v:r.debug?.targetSpeed,p={x:x(r.t),y:h-45-v/top*(h-60)};i?g.lineTo(p.x,p.y):g.moveTo(p.x,p.y)});g.stroke();}for(const r of rows){g.fillStyle='#70d59c';g.fillRect(x(r.t),h-3-r.controls.throttle*27,2,r.controls.throttle*27);g.fillStyle='#ff947d';g.fillRect(x(r.t),h-3-r.controls.brake*27,2,r.controls.brake*27);}g.strokeStyle='white';g.beginPath();g.moveTo(x(rows[index].t),0);g.lineTo(x(rows[index].t),h);g.stroke();}}
function frame(now){if(playing){if(last)carry+=(now-last)/1000;while(index<rows.length-1&&carry>=rows[index+1].t-rows[index].t){carry-=rows[index+1].t-rows[index].t;index++;}draw();if(index===rows.length-1){playing=false;$('play').textContent='Play';}}last=now;requestAnimationFrame(frame);}document.addEventListener('keydown',e=>{if(e.code==='Space'){e.preventDefault();$('play').click();}if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();index=Math.max(0,Math.min(rows.length-1,index+(e.key==='ArrowRight'?1:-1)));draw();}});draw();requestAnimationFrame(frame);
</script></html>`);
console.log('Encounter view: '+name+'.html');
