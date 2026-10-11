/** Additional physical views for the same recorded encounter; these never change simulation state. */
export const cameraMarkup=`<section class="card"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
<label>Camera <select id="camera"><option value="body">Body — true scale</option><option value="road">Road aligned</option><option value="pair">Rival close-up</option><option value="track">Whole track</option></select></label>
<label>Rival <select id="camera-rival"><option value="auto">Current target / nearest ahead</option></select></label>
<label>Zoom <select id="camera-zoom"><option value=".65">Wide</option><option value="1" selected>Normal</option><option value="1.7">Close</option></select></label>
<label><input type="checkbox" id="camera-trails" checked style="width:auto"> Actual trails</label>
<label><input type="checkbox" id="camera-ghosts" checked style="width:auto"> Solo / no-hazard ghosts</label></div>
<canvas id="camera-map"></canvas><p id="camera-note" style="margin-bottom:0"></p>
<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button id="event-prev">Previous encounter</button><button id="event-next">Next encounter</button><span style="color:#9aabc0">Arrow keys step the trace; space plays.</span></div></section>`;

export const cameraScript=String.raw`
const rivalIds=[...new Set(rows[0].cars.filter(c=>c.classId!=='lmdh').map(c=>c.id))];
for(const id of rivalIds){const o=document.createElement('option');o.value=id;o.textContent='GT3 '+id;$('camera-rival').append(o);}
const turn=a=>Math.atan2(Math.sin(a),Math.cos(a));
function roadPoint(s){const points=DATA.track.geometry,L=DATA.track.length,d=((s%L)+L)%L;let i=points.findIndex(p=>p.s>d);if(i<0)i=points.length;
 const a=points[(i-1+points.length)%points.length],b=points[i%points.length],span=((b.s-a.s+L)%L)||L,u=((d-a.s+L)%L)/span;
 return {x:a.x+(b.x-a.x)*u,z:a.z+(b.z-a.z)*u,heading:a.heading+turn(b.heading-a.heading)*u};}
function drawCamera(r,d){
 const {g,w,h}=canvas('camera-map'),self=r.cars.find(c=>c.classId==='lmdh'),choice=$('camera-rival').value;
 const rival=choice==='auto'?(r.cars.find(c=>c.id===d.focus&&c!==self)||r.cars.filter(c=>c!==self&&c.gap>0).sort((a,b)=>a.gap-b.gap)[0]||r.cars.filter(c=>c!==self).sort((a,b)=>Math.abs(a.gap)-Math.abs(b.gap))[0]):r.cars.find(c=>String(c.id)===choice);
 const mode=$('camera').value,zoom=+$('camera-zoom').value,road=roadPoint(r.s),centre=mode==='pair'&&rival?{x:(self.x+rival.x)/2,z:(self.z+rival.z)/2}:self;
 const yaw=mode==='body'?self.yaw:mode==='track'?0:road.heading,sy=Math.sin(yaw),cy=Math.cos(yaw);
 let scale=Math.min(w/45,h/115)*zoom,origin={x:w*.5,y:h*.75},cx=centre.x,cz=centre.z;
 if(mode==='pair'){const range=rival?Math.hypot(rival.x-self.x,rival.z-self.z):15;scale=Math.min(w/25,h/Math.max(18,range+12))*zoom;origin.y=h*.5;}
 if(mode==='track'){const points=DATA.track.geometry,xs=points.map(q=>q.x),zs=points.map(q=>q.z),loX=Math.min(...xs),hiX=Math.max(...xs),loZ=Math.min(...zs),hiZ=Math.max(...zs);
   scale=Math.min((w-36)/(hiX-loX+20),(h-36)/(hiZ-loZ+20));cx=(loX+hiX)/2;cz=(loZ+hiZ)/2;origin={x:w*.5,y:h*.5};}
 const xy=(x,z)=>{const dx=x-cx,dz=z-cz;return [origin.x+(dx*cy-dz*sy)*scale,origin.y-(dx*sy+dz*cy)*scale];};
 const line=(points,color,dash=[],width=1.6)=>{if(!points?.length)return;g.strokeStyle=color;g.lineWidth=width;g.setLineDash(dash);g.beginPath();points.forEach((q,i)=>{const p=xy(q.x,q.z);i?g.lineTo(...p):g.moveTo(...p);});g.stroke();g.setLineDash([]);};
 const L=DATA.track.length,width=DATA.track.halfWidth,dist=(a,b)=>((a-b+L*1.5)%L)-L*.5;
 const points=mode==='track'?[...DATA.track.geometry,DATA.track.geometry[0]]:DATA.track.geometry.filter(q=>Math.abs(dist(q.s,r.s))<Math.max(190,rival?Math.abs(rival.gap)+40:190));
 const edges=[-1,1].map(side=>points.map(q=>({x:q.x+Math.cos(q.heading)*width*side,z:q.z-Math.sin(q.heading)*width*side})));
 g.fillStyle='#263340';g.beginPath();[...edges[0],...edges[1].slice().reverse()].forEach((q,i)=>{const p=xy(q.x,q.z);i?g.lineTo(...p):g.moveTo(...p);});g.closePath();g.fill();
 for(const edge of edges)line(edge,'#8295a6');line(points,'#465565',[6,8],1);
 if(mode!=='track'){const step=5*scale;g.strokeStyle='#344354';g.lineWidth=.5;for(let x=origin.x%step;x<w;x+=step){g.beginPath();g.moveTo(x,0);g.lineTo(x,h);g.stroke();}for(let y=origin.y%step;y<h;y+=step){g.beginPath();g.moveTo(0,y);g.lineTo(w,y);g.stroke();}}
 line(solo.filter(q=>Math.abs(q.road-r.road)<180),'#8797a8',[4,6]);line(r.route,'#f7cf46',[],2);
 if($('camera-trails').checked){const begin=Math.max(0,index-20);for(const c of r.cars){const trail=rows.slice(begin,index+1).map(q=>q.cars.find(x=>x.id===c.id)).filter(Boolean);line(trail,c.hazard?'#ff947d':c===self?'#c9a62f':'#317c89',[],1);}}
 if($('forecast').checked)for(const q of d.observed??[]){if(q.physical){const c=r.cars.find(c=>c.id===q.id);if(c)line([c,...q.forecast??[]],q.hazard?'#ff947d':'#51d5df',[3,5]);}}
 if($('camera-ghosts').checked){for(const [trace,colour,label]of [[solo,'#b0bdca','Solo'],[DATA.hazardControl?.trace,'#70d59c','No hazard']]){
   if(!trace?.length)continue;let lo=0,hi=trace.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(trace[mid].time<r.time)lo=mid+1;else hi=mid;}
   const ghost=trace[lo].cars?.find(c=>c.classId==='lmdh');if(!ghost)continue;
   g.strokeStyle=colour;g.lineWidth=1.5;g.setLineDash([3,3]);g.beginPath();
   [[-.98,-2.28],[.98,-2.28],[.98,2.28],[-.98,2.28]].forEach(([a,b],i)=>{const p=xy(ghost.x+Math.cos(ghost.yaw)*a+Math.sin(ghost.yaw)*b,ghost.z-Math.sin(ghost.yaw)*a+Math.cos(ghost.yaw)*b);i?g.lineTo(...p):g.moveTo(...p);});g.closePath();g.stroke();g.setLineDash([]);
   const p=xy(ghost.x,ghost.z);g.fillStyle=colour;g.font='11px system-ui';g.fillText(label,p[0]+8,p[1]+14);
 }}
 let labelIndex=0;for(const c of r.cars){const colour=c.hazard?'#ff947d':c===self?'#f7cf46':'#51d5df';g.fillStyle=colour;g.strokeStyle=c===rival?'#fff':colour;g.lineWidth=c===rival?1.5:1;g.beginPath();
   [[-.98,-2.28],[.98,-2.28],[.98,2.28],[-.98,2.28]].forEach(([a,b],i)=>{const p=xy(c.x+Math.cos(c.yaw)*a+Math.sin(c.yaw)*b,c.z-Math.sin(c.yaw)*a+Math.cos(c.yaw)*b);i?g.lineTo(...p):g.moveTo(...p);});g.closePath();g.fill();g.stroke();
   if(mode==='track'){const p=xy(c.x,c.z);g.beginPath();g.arc(p[0],p[1],c===self?4:3,0,Math.PI*2);g.fill();}
   const p=xy(c.x,c.z);g.fillStyle='#e9edf4';g.font='11px system-ui';
   const ly=mode==='track'?p[1]-12-labelIndex++*15:p[1]-7;g.fillText((c===self?'GTP':'GT3 '+c.id)+' '+F(c.speed*3.6,0),p[0]+7,ly);
 }
 let pair='';if(rival){const a=roadPoint(self.s).heading,b=roadPoint(rival.s).heading;
   const across=c=>Math.abs(Math.cos(turn(c.yaw-roadPoint(c.s).heading)))*.98+Math.abs(Math.sin(turn(c.yaw-roadPoint(c.s).heading)))*2.28;
   const half=c=>Math.abs(Math.cos(turn(c.yaw-roadPoint(c.s).heading)))*2.28+Math.abs(Math.sin(turn(c.yaw-roadPoint(c.s).heading)))*.98;
   const space=Math.abs(self.lateral-rival.lateral)-across(self)-across(rival),clear=-rival.gap-half(self)-half(rival);
   pair='GT3 '+rival.id+': gap '+F(rival.gap,1)+' m; lateral body gap '+F(space,2)+' m; rear clearance '+F(clear,2)+' m; closing '+F((self.speed-rival.speed)*3.6,1)+' km/h.';
   if(mode==='pair'){line([self,rival],'#75859c',[2,5],1);}
 }
 g.fillStyle='#aab6c7';g.font='11px system-ui';g.fillText(mode==='track'?'Physical track map':mode==='body'?'Body heading · equal metre scale':mode==='road'?'Road heading · equal metre scale':'Pair view · equal metre scale',10,18);
 const bar=Math.min(50,mode==='track'?Math.max(10,Math.round(50/scale/10)*10):10),bx=12,by=h-20;g.strokeStyle='#d9e3ef';g.beginPath();g.moveTo(bx,by);g.lineTo(bx+bar*scale,by);g.stroke();g.fillText(bar+' m',bx,by-5);
 $('camera-note').textContent=pair+' These views use one equal scale for both axes. Trails show actual motion; dashed forecasts show predictions. Ghost bodies compare at the same elapsed time.';
}
function jumpEncounter(direction){const times=DATA.passes.flatMap(p=>[p.start,p.overlapAt,p.clear?.time,p.retained]).filter(Number.isFinite).sort((a,b)=>a-b),t=rows[index].time;
 const next=direction>0?times.find(x=>x>t+.11):times.filter(x=>x<t-.11).at(-1);if(next!==undefined){index=Math.max(0,rows.findIndex(x=>x.time>=next));draw();}}
for(const id of ['camera','camera-rival','camera-zoom','camera-trails','camera-ghosts'])$(id).onchange=()=>draw();
$('event-prev').onclick=()=>jumpEncounter(-1);$('event-next').onclick=()=>jumpEncounter(1);
document.addEventListener('keydown',e=>{if(['INPUT','SELECT','BUTTON'].includes(e.target.tagName))return;if(e.code==='Space'){e.preventDefault();$('play').click();}else if(e.code==='ArrowRight'||e.code==='ArrowLeft'){e.preventDefault();index=Math.max(0,Math.min(rows.length-1,index+(e.code==='ArrowRight'?1:-1)*(e.shiftKey?10:1)));draw();}});
const drawOriginal=draw;draw=function(){drawOriginal();drawCamera(rows[index],rows[index].debug??{});};
`;
