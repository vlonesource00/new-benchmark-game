// GPU training-episode viewer: recordings written by gpu-sim/run_env.py (results/gpu-episodes/<run>/*.json),
// with an optional JS replay (results/*.json) drawn as grey outlines at the same scene time for parity debugging.
const $ = id => document.getElementById(id);
const fmt = (x, n = 1) => Number.isFinite(x) ? x.toFixed(n) : '—';
const params = new URLSearchParams(location.search);
let ep = null, js = null, index = 0, playing = false, last = 0, clock = 0;

function setup(canvas) {
  const box = canvas.getBoundingClientRect(), dpr = devicePixelRatio;
  canvas.width = box.width * dpr; canvas.height = box.height * dpr;
  const c = canvas.getContext('2d'); c.scale(dpr, dpr); return { c, w: box.width, h: box.height };
}
const carColor = (k, f) => k === 0 ? '#ffd166' : ep.hazards[k] ? '#ff7080' : '#51d5df';
// JS replay poses at time t: [{x, z, yaw}] for ego then rivals (rows are every third decision).
function jsPoses(t) {
  if (!js) return null;
  const rows = js.rows; let lo = 0, hi = rows.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rows[mid].time <= t) lo = mid; else hi = mid - 1; }
  const r = rows[lo]; if (!r || Math.abs(r.time - t) > .2) return null;
  return [r.before, ...(r.cars ?? []).filter(c => c.id !== r.before.id)];
}
function body(c, project, scale, car, color, outline = false) {
  const [x, y] = project(car[0], car[1]);
  // Screen right is sin(rot) of forward: a positive yaw difference turns the body clockwise.
  c.save(); c.translate(x, y); c.rotate(car.rot);
  if (outline) { c.strokeStyle = color; c.lineWidth = 1.5; c.strokeRect(-.98 * scale, -2.28 * scale, 1.96 * scale, 4.56 * scale); }
  else { c.fillStyle = color; c.fillRect(-.98 * scale, -2.28 * scale, 1.96 * scale, 4.56 * scale); }
  c.restore();
}
function track(c, project, width, scale) {
  const nodes = ep.track.nodes;
  c.lineJoin = 'round';
  c.strokeStyle = '#2b3f53'; c.lineWidth = Math.max(2, (ep.track.halfWidth + (ep.track.curbWidth ?? 0)) * 2 * scale); c.beginPath();
  nodes.forEach((n, i) => c[i ? 'lineTo' : 'moveTo'](...project(n[0], n[1]))); c.closePath(); c.stroke();
  c.strokeStyle = '#354d64'; c.lineWidth = Math.max(2, ep.track.halfWidth * 2 * scale); c.beginPath();
  nodes.forEach((n, i) => c[i ? 'lineTo' : 'moveTo'](...project(n[0], n[1]))); c.closePath(); c.stroke();
  if (width) { c.strokeStyle = '#46607a'; c.lineWidth = 1; c.setLineDash([4, 6]); c.beginPath(); nodes.forEach((n, i) => c[i ? 'lineTo' : 'moveTo'](...project(n[0], n[1]))); c.closePath(); c.stroke(); c.setLineDash([]); }
}
// Screen rotation: forward (sin yaw, cos yaw) points up in the chase view.
function chase() {
  const { c, w, h } = setup($('chase')); c.fillStyle = '#101a26'; c.fillRect(0, 0, w, h);
  const f = ep.frames[index], ego = f.cars[0], yaw = ego[2], range = 90, scale = h / (range * 1.45);
  const project = (x, z) => { const dx = x - ego[0], dz = z - ego[1];
    return [w / 2 + (dx * Math.cos(yaw) - dz * Math.sin(yaw)) * scale, h * .72 - (dx * Math.sin(yaw) + dz * Math.cos(yaw)) * scale]; };
  track(c, project, true, scale);
  const trail = ep.frames.slice(Math.max(0, index - 60), index + 1);
  c.strokeStyle = '#ffd166aa'; c.lineWidth = 2; c.beginPath(); trail.forEach((q, i) => c[i ? 'lineTo' : 'moveTo'](...project(q.cars[0][0], q.cars[0][1]))); c.stroke();
  const ghosts = jsPoses(f.t);
  if (ghosts) ghosts.forEach((g, k) => body(c, project, scale, Object.assign([g.x, g.z], { rot: g.yaw - yaw }), k ? '#9aa9b8' : '#e8e0c0', true));
  const labels = [];
  f.cars.forEach((car, k) => {
    body(c, project, scale, Object.assign([car[0], car[1]], { rot: car[2] - yaw }), carColor(k));
    let [x, y] = project(car[0], car[1]);
    if (Math.abs(x - w / 2) < w && y > -20 && y < h + 20) {
      // Side-by-side cars: stack labels instead of overprinting them.
      x += 2.5 * scale + 4; while (labels.some(l => Math.abs(l[1] - y) < 14 && Math.abs(l[0] - x) < 170)) y += 14; labels.push([x, y]);
      c.fillStyle = carColor(k); c.font = '12px system-ui';
      c.fillText(`${k ? ep.drivers[k] + ' ' + ep.classes[k] : 'PULSE'} · ${fmt(car[3] * 3.6, 0)} km/h · ${fmt(car[5] * 100, 1)}% dmg`, x, y); }
  });
  c.fillStyle = '#91a7bc'; c.font = '12px system-ui'; c.fillText('Chase view · forward up · 1 m grid ≈ ' + fmt(scale, 1) + ' px', 10, 18);
}
function map() {
  const { c, w, h } = setup($('map')); c.fillStyle = '#101a26'; c.fillRect(0, 0, w, h);
  const nodes = ep.track.nodes, xs = nodes.map(n => n[0]), zs = nodes.map(n => n[1]);
  const minX = Math.min(...xs), minZ = Math.min(...zs), scale = Math.min((w - 40) / (Math.max(...xs) - minX), (h - 40) / (Math.max(...zs) - minZ));
  const project = (x, z) => [20 + (x - minX) * scale, h - 20 - (z - minZ) * scale];
  track(c, project, false, scale);
  c.strokeStyle = '#ffd16688'; c.lineWidth = 2; c.beginPath(); ep.frames.slice(0, index + 1).forEach((q, i) => c[i ? 'lineTo' : 'moveTo'](...project(q.cars[0][0], q.cars[0][1]))); c.stroke();
  const f = ep.frames[index];
  f.cars.forEach((car, k) => { const [x, y] = project(car[0], car[1]); c.fillStyle = carColor(k); c.beginPath(); c.arc(x, y, k ? 4 : 6, 0, 7); c.fill(); });
  for (const e of ep.events) { const q = ep.frames.find(q => q.t >= e.time); if (!q) continue; const [x, y] = project(q.cars[0][0], q.cars[0][1]);
    c.strokeStyle = e.type === 'contact' ? '#ff7080' : '#7ef0c4'; c.lineWidth = 2; c.beginPath(); c.arc(x, y, 8, 0, 7); c.stroke(); }
}
function charts() {
  const { c, w, h } = setup($('charts')); c.fillStyle = '#0f1823'; c.fillRect(0, 0, w, h);
  const F = ep.frames, T = ep.seconds, X = t => 40 + t / T * (w - 50);
  const lanes = [['speed km/h', q => q.cars[0][3] * 3.6, 0, 330, '#51d5df'], ['throttle', q => q.controls[0], 0, 1, '#50d4b6'], ['brake', q => q.controls[1], 0, 1, '#ff7080'],
    ['steer', q => q.controls[2], -1, 1, '#a99aff'], ['reward', q => q.reward, Math.min(0, ...F.map(q => q.reward)), Math.max(1, ...F.map(q => q.reward)), '#ffd166']];
  const band = (h - 20) / lanes.length;
  lanes.forEach(([name, get, lo, hi, color], k) => {
    const top = 10 + k * band, Y = v => top + band - 4 - (v - lo) / (hi - lo || 1) * (band - 8);
    c.fillStyle = '#5d7489'; c.font = '11px system-ui'; c.fillText(name, 4, top + 12);
    c.strokeStyle = color; c.lineWidth = 1.3; c.beginPath(); F.forEach((q, i) => c[i ? 'lineTo' : 'moveTo'](X(q.t), Y(get(q)))); c.stroke();
    if (k === 0) { c.strokeStyle = '#ffffff55'; c.setLineDash([3, 3]); c.beginPath(); F.forEach((q, i) => c[i ? 'lineTo' : 'moveTo'](X(q.t), Y(Math.min(330, q.target * 3.6)))); c.stroke(); c.setLineDash([]); }
  });
  for (const e of ep.events) { c.strokeStyle = e.type === 'contact' ? '#ff708099' : '#7ef0c499'; c.beginPath(); c.moveTo(X(e.time), 6); c.lineTo(X(e.time), h - 6); c.stroke(); }
  c.strokeStyle = '#ffffff'; c.beginPath(); c.moveTo(X(ep.frames[index].t), 0); c.lineTo(X(ep.frames[index].t), h); c.stroke();
}
function side() {
  const f = ep.frames[index], ego = f.cars[0];
  const metric = (k, v) => `<div class="metric"><small>${k}</small><strong>${v}</strong></div>`;
  $('metrics').innerHTML = metric('Speed', fmt(ego[3] * 3.6, 0) + ' km/h') + metric('Road offset', fmt(ego[4], 2) + ' m') + metric('Damage', fmt(ego[5] * 100, 1) + '%')
    + metric('Progress', fmt(f.progress, 0) + ' m') + metric('Track-limit time', fmt(f.limit, 2) + ' s') + metric('Reward so far', fmt(f.reward, 2));
  const bar = (name, v, cls, lo = 0) => `<div class="pedal ${cls}"><span>${name}</span><div class="bar"><i style="width:${Math.round(Math.abs(v - lo) / (1 - lo) * 100)}%"></i></div><span>${fmt(v, 2)}</span></div>`;
  const p = f.plan;
  $('pedals').innerHTML = bar('Throttle', f.controls[0], '') + bar('Brake', f.controls[1], 'brake') + bar('Steer', f.controls[2], 'steer', -1)
    + `<p>Plan knots (lateral goals): ${p.slice(0, 3).map(v => fmt(v * 6, 1) + ' m').join(' / ')}<br>Speed cap ${fmt((95 + Math.min(0, Math.max(-1, p[3])) * 70) * 3.6, 0)} km/h · executor target ${fmt(f.target * 3.6, 0)} km/h</p>`;
  $('clock').textContent = `${fmt(f.t, 2)} / ${fmt(ep.seconds, 0)} s`; $('scrub').value = index;
}
function render() { if (!ep) return; chase(); map(); charts(); side(); }
async function loadEpisode(url) {
  ep = await (await fetch(url)).json(); index = 0; $('scrub').max = ep.frames.length - 1;
  const o = ep.outcome ?? {}, ok = o.success;
  $('summary').innerHTML = `<span class="badge ${ok ? 'ok' : 'bad'}">${ok ? 'SUCCESS' : 'FAILED'}</span><span class="chip">${ep.scene} · ${ep.family} · ${ep.count} cars · `
    + `${ep.drivers.slice(1).map((d, k) => d + (ep.hazards[k + 1] ? ' (' + ep.hazards[k + 1] + ')' : '')).join(', ')}</span><p>`
    + `admissible ${o.admissible ? 'yes' : 'no'} · severe contact ${o.severe ? 'yes' : 'no'} · damage ${fmt((o.damage ?? 0) * 100, 1)}% · track-limit ${fmt(o.limit, 2)} s · `
    + `passes ${o.passes ?? 0} · hazards cleared ${o.hazards ?? 0} · unpassed traffic ${o.unpassed ?? 0} · model ${ep.model}${ep.sigma ? ' σ ' + ep.sigma : ''}</p>`;
  $('events').replaceChildren();
  for (const e of ep.events) { const b = document.createElement('button'); b.className = 'event'; b.textContent = `${fmt(e.time, 2)} s · ${e.type} · car ${e.with} (${ep.drivers[e.with]})`;
    b.onclick = () => { index = Math.max(0, ep.frames.findIndex(q => q.t >= e.time - .5)); render(); }; $('events').append(b); }
  const u = new URL(location.href); u.searchParams.set('run', $('run').value); u.searchParams.set('episode', url.split('/').pop()); history.replaceState(null, '', u);
  render();
}
async function loadRun(run) {
  const list = runs.find(r => r.name === run)?.episodes ?? [];
  $('episode').replaceChildren(...list.map(e => Object.assign(document.createElement('option'), { value: e.url, textContent: e.name.replace('.json', '') })));
  const want = params.get('episode'); if (want && list.some(e => e.name === want)) $('episode').value = list.find(e => e.name === want).url;
  if (list.length) await loadEpisode($('episode').value);
}
const runs = await (await fetch('/api/gpu-episodes')).json();
$('run').replaceChildren(...runs.map(r => Object.assign(document.createElement('option'), { value: r.name, textContent: r.name })));
if (params.get('run') && runs.some(r => r.name === params.get('run'))) $('run').value = params.get('run');
const replays = await (await fetch('/api/episodes')).json();
for (const r of replays.filter(r => r.name.startsWith('watch-') || r.name.includes('gpu')).slice(0, 200))
  $('overlay').append(Object.assign(document.createElement('option'), { value: r.url, textContent: r.name.replace('.json', '') }));
$('run').onchange = () => loadRun($('run').value);
$('episode').onchange = () => loadEpisode($('episode').value);
$('overlay').onchange = async () => { js = $('overlay').value ? await (await fetch($('overlay').value)).json() : null; render(); };
$('scrub').oninput = () => { index = +$('scrub').value; clock = ep.frames[index].t; render(); };
$('play').onclick = () => {
  if (!ep) return;
  if (!playing && index >= ep.frames.length - 1) index = 0;
  playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play';
  clock = ep.frames[index].t; last = null; if (playing) requestAnimationFrame(tick);
};
function tick(now) {
  if (!playing || !ep) return;
  // A continuous clock: frames are 20 Hz, display frames ~60 Hz, so the fraction must carry over.
  if (last !== null) clock += Math.max(0, now - last) / 1000 * +$('rate').value;
  last = now;
  while (index < ep.frames.length - 1 && ep.frames[index + 1].t <= clock) index++;
  if (index >= ep.frames.length - 1) { playing = false; $('play').textContent = 'Play'; }
  render(); if (playing) requestAnimationFrame(tick);
}
addEventListener('resize', render);
if (runs.length) await loadRun($('run').value); else $('summary').textContent = 'No GPU episodes yet: run gpu-sim/run_env.py with --record N --out results/gpu-episodes/<name>.';
