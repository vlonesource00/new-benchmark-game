const $ = id => document.getElementById(id);
let replay, index = 0, playing = false, elapsed = 0, previousTime = 0, featureIndex = new Map();
const format = (x, n = 2) => Number.isFinite(x) ? x.toFixed(n) : '—';
const canvas = $('view'), chart = $('chart');
function setup(canvas) { const box = canvas.getBoundingClientRect(), dpr = devicePixelRatio; canvas.width = box.width * dpr; canvas.height = box.height * dpr; const c = canvas.getContext('2d'); c.scale(dpr, dpr); return { c, w: box.width, h: box.height }; }
function scene(row) {
  const { c, w, h } = setup(canvas); c.fillStyle = '#101a26'; c.fillRect(0, 0, w, h);
  const ego = row.before, mode = $('camera').value, road = row.observation.road;
  const visibleCars = mode === 'track' ? row.cars : row.cars.filter(p => p.id === ego.id || Math.hypot(p.x - ego.x, p.z - ego.z) <= 300);
  let project, scale, xScale;
  if (mode === 'track') {
    const points = replay.track.outline, xs = points.map(p => p.x), zs = points.map(p => p.z), minX = Math.min(...xs), minZ = Math.min(...zs);
    scale = Math.min((w - 70) / (Math.max(...xs) - minX), (h - 70) / (Math.max(...zs) - minZ));
    project = p => [35 + (p.x - minX) * scale, h - 35 - (p.z - minZ) * scale];
    c.strokeStyle = '#354d64'; c.lineWidth = Math.max(3, replay.track.halfWidth * 2 * scale); c.beginPath();
    points.forEach((p, i) => c[i ? 'lineTo' : 'moveTo'](...project(p))); c.closePath(); c.stroke();
  } else if (mode === 'road') {
    const ahead = p => { let ds = p.s - road.s; if (ds > replay.track.length / 2) ds -= replay.track.length; if (ds < -replay.track.length / 2) ds += replay.track.length; return ds; };
    scale = h * .70 / (Math.max(140, ...visibleCars.map(ahead)) + 35);
    const xScale = (w - 60) / (replay.track.halfWidth * 2 + 6);
    project = p => {
      if (p.id !== undefined) { let ds = p.s - road.s; if (ds > replay.track.length / 2) ds -= replay.track.length; if (ds < -replay.track.length / 2) ds += replay.track.length;
        return [w / 2 + p.lateral * xScale, h * .76 - ds * scale]; }
      return [w / 2, h * .76 - p.distance * scale];
    };
    for (let x = -replay.track.halfWidth; x <= replay.track.halfWidth; x += 2) {
      c.strokeStyle = Math.abs(x) > replay.track.halfWidth - 2 ? '#697e90' : '#25374a'; c.beginPath(); c.moveTo(w / 2 + x * xScale, 20); c.lineTo(w / 2 + x * xScale, h); c.stroke();
    }
  } else {
    const farthest = Math.max(180, ...visibleCars.map(p => (p.x - ego.x) * Math.sin(ego.yaw) + (p.z - ego.z) * Math.cos(ego.yaw)));
    const side = p => (p.x - ego.x) * Math.cos(ego.yaw) - (p.z - ego.z) * Math.sin(ego.yaw);
    const extent = Math.max(replay.track.halfWidth + 8, ...visibleCars.map(p => Math.abs(side(p)) + 5));
    scale = h * .74 / (farthest + 25); xScale = (w - 65) / (extent * 2);
    project = p => { const dx = p.x - ego.x, dz = p.z - ego.z;
      return [w / 2 + (dx * Math.cos(ego.yaw) - dz * Math.sin(ego.yaw)) * xScale,
        h * .78 - (dx * Math.sin(ego.yaw) + dz * Math.cos(ego.yaw)) * scale]; };
    for (let x = -Math.ceil(extent / 5) * 5; x <= extent; x += 5) { c.strokeStyle = '#263849'; c.beginPath(); c.moveTo(w / 2 + x * xScale, 0); c.lineTo(w / 2 + x * xScale, h); c.stroke(); }
    for (const lateral of [-replay.track.halfWidth, 0, replay.track.halfWidth]) {
      c.strokeStyle = lateral ? '#72899e' : '#4b667b'; c.lineWidth = lateral ? 2 : 1; c.beginPath();
      row.observation.preview.forEach((p, i) => c[i ? 'lineTo' : 'moveTo'](...project({ x: p.x + p.nx * lateral, z: p.z + p.nz * lateral }))); c.stroke();
    }
  }
  // Preview is a sensor of the centre of the road, never a claimed policy route.
  if (mode !== 'track') { c.strokeStyle = '#889fb2'; c.setLineDash([5, 5]); c.beginPath(); row.observation.preview.forEach((p, i) => c[i ? 'lineTo' : 'moveTo'](...project(p))); c.stroke(); c.setLineDash([]); }
  const history = replay.rows.slice(Math.max(0, index - 60), index + 1);
  c.strokeStyle = '#ffd166'; c.lineWidth = 2; c.beginPath(); history.forEach((r, i) => c[i ? 'lineTo' : 'moveTo'](...project(r.before))); c.stroke();
  for (const car of visibleCars) {
    const [x, y] = project(car); const color = car.id === ego.id ? '#ffd166' : car.speed < 5 ? '#ff7080' : '#51d5df';
    c.fillStyle = color; c.beginPath();
    if (mode === 'road') {
      const width = (w - 60) / (replay.track.halfWidth * 2 + 6);
      c.rect(x - .98 * width, y - 2.28 * scale, 1.96 * width, 4.56 * scale);
    } else {
      [[-.98, -2.28], [.98, -2.28], [.98, 2.28], [-.98, 2.28]].forEach(([side, front], i) => {
        const p = { x: car.x + side * Math.cos(car.yaw) + front * Math.sin(car.yaw), z: car.z - side * Math.sin(car.yaw) + front * Math.cos(car.yaw) };
        c[i ? 'lineTo' : 'moveTo'](...project(p));
      }); c.closePath();
    }
    c.fill(); c.fillStyle = color; c.font = '12px system-ui'; c.fillText(`${car.id === ego.id ? 'Ego' : 'Car ' + car.id} · ${format(car.speed * 3.6, 0)} km/h`, x + 12, y - 10);
  }
  c.fillStyle = '#91a7bc'; c.font = '12px system-ui'; c.fillText(mode === 'body' ? 'Forward is up · lateral scale expanded · executed trail in yellow' : mode === 'road' ? 'Road distance ahead · lateral position expanded' : 'Complete circuit · yellow executed trail', 16, 22);
}
function timeline() {
  const { c, w, h } = setup(chart); c.fillStyle = '#101a26'; c.fillRect(0, 0, w, h);
  const end = replay.rows.at(-1).time || 1, left = 38, bottom = h - 25;
  const mode = $('chart-mode').value, signed = value => .5 + .5 * Math.max(-1, Math.min(1, value));
  const raw = (r, name) => { const i = featureIndex.get(name); return i === undefined ? 0 : r.observation.raw[i]; };
  const modes = {
    resources: { label: 'Wake cyan · battery yellow · worst tyre wear red', series: [[r => raw(r, 'ego.wake'), '#51d5df'],
      [r => raw(r, 'ego.batteryFraction'), '#ffd166'], [r => Math.max(...r.before.tyres.map(t => t.wear)), '#ff7080']] },
    speed: { label: 'Speed cyan · throttle green · brake red', series: [[r => r.before.speed * 3.6 / 360, '#51d5df'], [r => r.executed.throttle, '#50d4b6'], [r => r.executed.brake, '#ff7080']] },
    steer: { label: 'Steering: expert grey · policy cyan · executed yellow', series: [[r => signed(r.teacherControls?.steer ?? 0), '#94a3b8'], [r => signed(r.policyProposal?.[0] ?? 0), '#51d5df'], [r => signed(r.executed.steer), '#ffd166']] },
    pedals: { label: 'Effort: expert grey · policy cyan · executed yellow', series: [[r => signed((r.teacherControls?.throttle ?? 0) - (r.teacherControls?.brake ?? 0)), '#94a3b8'], [r => signed(r.policyProposal?.[1] ?? 0), '#51d5df'], [r => signed(r.executed.throttle - r.executed.brake), '#ffd166']] },
    motion: { label: 'Angles: body sideslip cyan · road heading yellow (±0.6 rad)', series: [[r => {
      const psi = Math.atan2(raw(r, 'ego.headingSin'), raw(r, 'ego.headingCos'));
      const vf = raw(r, 'ego.forwardSpeed'), vs = raw(r, 'ego.sideSpeed');
      return signed(Math.atan2(vs * Math.cos(psi) - vf * Math.sin(psi), vf * Math.cos(psi) + vs * Math.sin(psi)) / .6);
    }, '#51d5df'], [r => signed(Math.atan2(raw(r, 'ego.headingSin'), raw(r, 'ego.headingCos')) / .6), '#ffd166']] }
  }, selected = modes[mode];
  c.fillStyle = '#91a7bc'; c.font = '12px system-ui'; c.fillText(selected.label, 16, 18);
  if (mode !== 'speed') { c.strokeStyle = '#354d64'; c.beginPath(); c.moveTo(left, bottom - .5 * (h - 50)); c.lineTo(w - 15, bottom - .5 * (h - 50)); c.stroke(); }
  for (const [getter, color] of selected.series) {
    c.strokeStyle = color; c.lineWidth = 1; c.beginPath(); replay.rows.forEach((r, i) => c[i ? 'lineTo' : 'moveTo'](left + r.time / end * (w - left - 15), bottom - getter(r) * (h - 50))); c.stroke();
  }
  const x = left + replay.rows[index].time / end * (w - left - 15); c.strokeStyle = '#ffd166'; c.beginPath(); c.moveTo(x, 25); c.lineTo(x, bottom); c.stroke();
}
function render() {
  if (!replay) return;
  const row = replay.rows[index]; $('scrub').value = index; $('clock').textContent = `${format(row.time)} / ${format(replay.summary.seconds)} s`;
  scene(row); timeline();
  const passes = replay.events.filter(e => e.type === 'retained-pass' && e.time <= row.time);
  const wake = row.observation.raw[featureIndex.get('ego.wake')] ?? 0;
  const metrics = [['Speed', format(row.before.speed * 3.6, 1) + ' km/h'], ['Road offset', format(row.before.lateral) + ' m'], ['Fuel', format(row.before.fuel, 1) + ' L'], ['Damage', format(row.before.damage * 100, 1) + '%'], ['Action age', format(row.actionAge * 1000, 1) + ' ms'], ['Retained / clean', `${passes.length} / ${passes.filter(e => e.contactContaminated === false).length}`],
    ['Wake exposure', format(wake * 100, 1) + '%'], ['Worst tyre wear', format(Math.max(...row.before.tyres.map(t => t.wear)) * 100, 1) + '%']];
  $('metrics').replaceChildren(...metrics.map(([label, value]) => { const d = document.createElement('div'); d.className = 'metric'; const a = document.createElement('small'), b = document.createElement('strong'); a.textContent = label; b.textContent = value; d.append(a, b); return d; }));
  const pedals = $('pedals'); pedals.replaceChildren();
  for (const [name, controls] of [['Teacher', row.teacherControls], ['Policy', row.policyProposal ? { steer: row.policyProposal[0], throttle: Math.max(0, row.policyProposal[1]), brake: Math.max(0, -row.policyProposal[1]) } : null], ['Executed', row.executed]]) {
    if (!controls) continue;
    for (const key of ['throttle', 'brake', 'steer']) { const d = document.createElement('div'); d.className = 'pedal ' + key; const label = document.createElement('small'), bar = document.createElement('span'), fill = document.createElement('i'), value = document.createElement('small');
      label.textContent = name + ' ' + key; bar.className = 'bar'; fill.style.width = Math.abs(controls[key]) * 100 + '%'; bar.append(fill); value.textContent = format(controls[key] * 100, 0) + '%'; d.append(label, bar, value); pedals.append(d); }
  }
  $('constraints').textContent = `${row.actionSource ?? replay.summary.mode}${row.expertChosen ? ' · expert assistance: ' + row.expertReason : ''}. ` +
    (row.safety.length ? `Safety: ${row.safety.join(', ')}${replay.summary.mode === 'shadow' ? ' (counterfactual)' : ''}` : 'No safety override at this observation.');
  $('latency').textContent = JSON.stringify({ decisionMs: row.decisionMs, recurrentDt: row.recurrentDt, requestDt: row.decisionDt,
    hiddenNorm: row.hiddenNorm, sequence: row.acceptedSequence, expertController: row.teacherTrace,
    expertHistoryProbe: row.teacherHistoryProbe, trainingDisturbance: row.trainingDisturbance,
    expertActuator: replay.manifest.expertActuator ?? replay.manifest.settings?.trainingExpertActuator,
    diagnostic: replay.manifest.diagnostic, networkInputsMasked: Boolean(row.diagnosticPolicyObservation),
    missing: row.observation.missing, clipped: row.observation.clipped, sensors: row.observation.selected, ignored: row.observation.rejected, inferenceMs: replay.summary.latencyMs.inference, mailbox: replay.summary.mailbox }, null, 2);
  const filter = $('filter').value.toLowerCase(); $('features').replaceChildren();
  replay.schema.fields.forEach((field, i) => { if (filter && !field.name.toLowerCase().includes(filter)) return; const tr = document.createElement('tr');
    for (const text of [field.name, format(row.observation.raw[i], 4), format(row.observation.normalized[i], 4), `${field.min}…${field.max} / ${field.scale}`]) { const td = document.createElement('td'); td.textContent = text; tr.append(td); } $('features').append(tr); });
}
async function load(url) {
  replay = await (await fetch(url)).json(); index = 0; playing = false; $('play').textContent = 'Play'; $('scrub').max = replay.rows.length - 1;
  featureIndex = new Map(replay.schema.fields.map((field, i) => [field.name, i]));
  $('scope').textContent = `${replay.summary.scope} ${replay.summary.track} · ${replay.summary.classId} · seed ${replay.summary.seed}`;
  $('scope').className = ['policy', 'dagger'].includes(replay.summary.mode) ? 'warn' : '';
  if (replay.manifest.diagnostic) { $('scope').textContent += ' | Diagnostic: ' + replay.manifest.diagnostic; $('scope').className = 'warn'; }
  const meta = replay.manifest.policy;
  const checkpoint = meta?.checkpointDirectory ?? (meta?.checkpointEpoch ? `${meta.training.out}/epoch-${meta.checkpointEpoch}` : meta?.training?.out);
  document.querySelector('header a').href = '/gpu.html?model=' + encodeURIComponent(
    typeof checkpoint === 'string' && /^artifacts\/(?:model|models\/[a-z0-9-]+(?:\/epoch-[1-9][0-9]{0,2})?)$/i.test(checkpoint) ? checkpoint : 'artifacts/model');
  $('feature-count').textContent = `${replay.schema.size} normalized public features · IDs are debug-only`;
  $('training').textContent = meta ? JSON.stringify({ checkpointForThisReplay: meta.modelSha256, stage: meta.stage,
    architecture: meta.architecture, parameters: meta.parameters, trainableParameters: meta.trainableParameters,
    activeMemoryUnits: meta.activeMemoryUnits, actuationUsesRecurrentMemory: meta.actuationUsesRecurrentMemory, checkpointEpoch: meta.checkpointEpoch,
    checkpointSelection: meta.checkpointSelection, validationLoss: meta.bestValidationLoss, training: meta.training,
    trainingSeconds: meta.seconds, parent: meta.parentModelSha256, physicsDigest: meta.simulatorDigest }, null, 2) :
    'This is an expert demonstration. No PULSE checkpoint is controlling this replay.';
  $('events').replaceChildren();
  for (const event of replay.events.filter(e => e.type !== 'reply-accepted').slice(0, 150)) { const button = document.createElement('button'); button.className = 'event'; button.textContent = `${format(event.time)} s · ${event.type === 'off-track' ? 'asphalt-edge' : event.type}${event.id !== undefined ? ' car ' + event.id : ''}`;
    button.onclick = () => { index = Math.max(0, replay.rows.findIndex(r => r.time >= event.time)); render(); }; $('events').append(button); }
  render();
}
const episodes = await (await fetch('/api/episodes')).json();
for (const e of episodes) { const option = document.createElement('option'); option.value = e.url; option.textContent = e.name.replace('.json', ''); $('episode').append(option); }
const requested = new URLSearchParams(location.search).get('episode');
if (requested && episodes.some(e => e.url === '/results/' + requested + '.json')) $('episode').value = '/results/' + requested + '.json';
else if (episodes.some(e => e.name === 'train-traffic-8.json')) $('episode').value = '/results/train-traffic-8.json';
if (episodes.length) await load($('episode').value);
$('episode').onchange = () => load($('episode').value); $('camera').onchange = render; $('filter').oninput = render;
$('chart-mode').onchange = render;
$('scrub').oninput = () => { index = +$('scrub').value; render(); };
$('play').onclick = () => { playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; };
window.addEventListener('resize', render);
function animate(time) {
  if (playing && replay) { elapsed += (time - previousTime) / 1000 * +$('rate').value; const period = replay.rows[1]?.time - replay.rows[0].time || .05;
    if (elapsed >= period) { index = Math.min(replay.rows.length - 1, index + Math.floor(elapsed / period)); elapsed %= period; if (index === replay.rows.length - 1) playing = false; render(); } }
  previousTime = time; requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
