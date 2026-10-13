// PULSE network view: every neuron of the plan policy at one decision (gpu-sim/run_env.py --neurons).
// Layers: observation (ego, tyres, road, rival slots) -> frozen encoder (own context, rival mean / max pools)
// -> GRU memory -> intent hidden -> 4 plan outputs. Lines are the intent head's live contributions w * a.
const warm = [255, 181, 71], cool = [79, 195, 247];
const tint = (v, base = .07) => { const c = v >= 0 ? warm : cool, a = base + (1 - base) * Math.min(1, Math.abs(v)); return `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`; };

// Lay out a block of n cells in `cols` columns at (x, y); returns centres and the block's bottom edge.
function grid(n, cols, x, y, cell) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([x + (i % cols + .5) * cell, y + (Math.floor(i / cols) + .5) * cell]);
  return { pts, bottom: y + Math.ceil(n / cols) * cell, x, y, w: cols * cell, cell };
}

export function layout(net, w, h) {
  const g = net.groups, top = 26, room = h - top - 14;
  const blocks = [['ego', g.ego.size, 11], ['tyres', g.tyres.size, 8], ['road', g.road.size, 12], ['rivals', g.rivals.size, 18]];
  const rows = blocks.reduce((s, [, n, c]) => s + Math.ceil(n / c), 0);
  const cell = Math.max(3, Math.min((room - blocks.length * 16) / rows, w * .26 / 18));
  const L = { cell, inputs: [], names: {} };
  let y = top;
  for (const [name, n, cols] of blocks) { const b = grid(n, cols, w * .02, y + 13, cell); b.name = name; L.inputs.push(b); y = b.bottom + 4; }
  L.obs = L.inputs.flatMap(b => b.pts);
  const c2 = Math.min(cell * 1.6, room / 22, w * .15 / 8), col = x => w * x;
  const own = grid(64, 8, col(.36), top + 13, c2), mean = grid(32, 8, col(.36), own.bottom + 17, c2), max = grid(32, 8, col(.36), mean.bottom + 17, c2);
  const c3 = Math.min(cell * 2.2, room / 9.5, w * .15 / 8);
  const mem = grid(64, 8, col(.52), top + 13, c3), hid = grid(64, 8, col(.69), top + 13, c3);
  const outs = [0, 1, 2, 3].map(k => [col(.855), top + 30 + k * Math.min(48, room / 4.4)]);
  Object.assign(L, { own, mean, max, mem, hid, outs });
  // Intent-head input order (plan_model.py): [own 64, rival mean 32, rival max 32] + observation[0:220] + memory 64.
  L.intent = [...own.pts, ...mean.pts, ...max.pts, ...L.obs.slice(0, 220), ...mem.pts];
  return L;
}

// Decoded per decision once: playback revisits the same decision for several display frames.
const decoded = new WeakMap();
const frameValues = n => {
  if (decoded.has(n)) return decoded.get(n);
  const f = k => n[k].map(v => v / 100);
  const v = { obs: f('obs'), own: f('own'), mean: f('mean'), max: f('max'), mem: f('mem'), hid: f('hid'), out: f('out'), upd: f('upd') };
  v.intent = [...v.own, ...v.mean, ...v.max, ...v.obs.slice(0, 220), ...v.mem];
  decoded.set(n, v);
  return v;
};
// Flattened intent weights and reusable buffers: no per-frame allocation of 26k contribution records.
let flat = null;
function weights(net) {
  if (flat?.net === net) return flat;
  const H = net.w1.length, I = net.w1[0].length, w1 = new Float32Array(H * I);
  net.w1.forEach((row, j) => row.forEach((x, i) => { w1[j * I + i] = x; }));
  flat = { net, H, I, w1, q: new Float32Array(H * I), mag: new Float32Array(H * I) };
  return flat;
}

function bundle(c, from, to, activity) {
  const a = Math.min(.35, .04 + activity * .5);
  c.strokeStyle = `rgba(150,175,200,${a})`; c.lineWidth = 1;
  for (let k = 0; k < 7; k++) {
    const y0 = from.y + (from.bottom - from.y) * (k + .5) / 7, y1 = to.y + (to.bottom - to.y) * (k + .5) / 7;
    c.beginPath(); c.moveTo(from.x + from.w + 2, y0); c.bezierCurveTo((from.x + from.w + to.x) / 2, y0, (from.x + from.w + to.x) / 2, y1, to.x - 2, y1); c.stroke();
  }
}
const meanAbs = a => a.reduce((s, x) => s + Math.abs(x), 0) / a.length;

export function draw(c, net, L, n, w, h, hover) {
  c.fillStyle = '#0b131d'; c.fillRect(0, 0, w, h);
  if (!n) { c.fillStyle = '#5d7489'; c.font = '13px system-ui'; c.fillText('No neuron recording for this episode: run gpu-sim/run_env.py with --neurons.', 14, 24); return; }
  const v = frameValues(n), g = net.groups;
  const span = (name) => v.obs.slice(g[name].offset, g[name].offset + g[name].size);
  // Bundles: observation groups into the frozen encoder, encoder into the GRU memory.
  for (const b of L.inputs.slice(0, 3)) bundle(c, b, L.own, meanAbs(span(b.name)));
  bundle(c, L.inputs[3], L.mean, meanAbs(span('rivals'))); bundle(c, L.inputs[3], L.max, meanAbs(span('rivals')));
  for (const b of [L.own, L.mean, L.max]) bundle(c, b, L.mem, meanAbs(v.mem));
  // Intent head: the 320 strongest live contributions into its hidden layer, then all 256 into the outputs.
  const W = weights(net), { H, I, w1, q: contrib, mag } = W;
  for (let j = 0; j < H; j++) for (let i = 0; i < I; i++) { const q = w1[j * I + i] * v.intent[i]; contrib[j * I + i] = q; mag[j * I + i] = Math.abs(q); }
  const sorted = mag.slice().sort(), cut = Math.max(.02, sorted[sorted.length - 320] ?? 0), peak = sorted[sorted.length - 1] || 1;
  const lines = [];
  for (let k = 0; k < H * I; k++) if (mag[k] >= cut) lines.push([mag[k], contrib[k], k % I, Math.floor(k / I)]);
  lines.sort((a, b) => a[0] - b[0]);
  for (const [m, q, i, j] of lines) {
    const [x0, y0] = L.intent[i], [x1, y1] = L.hid.pts[j], cl = q >= 0 ? warm : cool;
    c.strokeStyle = `rgba(${cl[0]},${cl[1]},${cl[2]},${(.05 + .55 * m / peak).toFixed(3)})`; c.lineWidth = .6 + 1.4 * m / peak;
    c.beginPath(); c.moveTo(x0, y0); c.bezierCurveTo((x0 + x1) / 2, y0, (x0 + x1) / 2, y1, x1, y1); c.stroke();
  }
  let peak2 = 1e-6; net.w2.forEach((row) => row.forEach((wt, j) => { peak2 = Math.max(peak2, Math.abs(wt * v.hid[j])); }));
  net.w2.forEach((row, k) => row.forEach((wt, j) => {
    const q = wt * v.hid[j], cl = q >= 0 ? warm : cool, [x0, y0] = L.hid.pts[j], [x1, y1] = L.outs[k];
    c.strokeStyle = `rgba(${cl[0]},${cl[1]},${cl[2]},${(.03 + .6 * Math.abs(q) / peak2).toFixed(3)})`; c.lineWidth = .5 + 1.5 * Math.abs(q) / peak2;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1 - 6, y1); c.stroke();
  }));
  // Neurons.
  const cells = (pts, vals, size, round) => pts.forEach(([x, y], i) => { c.fillStyle = tint(vals[i]);
    if (round) { c.beginPath(); c.arc(x, y, size * .42, 0, 7); c.fill(); } else c.fillRect(x - size * .43, y - size * .43, size * .86, size * .86); });
  L.inputs.forEach(b => cells(b.pts, span(b.name), b.cell, false));
  cells(L.own.pts, v.own, L.own.cell, true); cells(L.mean.pts, v.mean, L.mean.cell, true); cells(L.max.pts, v.max, L.max.cell, true);
  cells(L.mem.pts, v.mem, L.mem.cell, true); cells(L.hid.pts, v.hid, L.hid.cell, true);
  // Memory update gate: a ring per unit, bright when the unit holds its state (1) rather than rewriting it.
  L.mem.pts.forEach(([x, y], i) => { c.strokeStyle = `rgba(200,220,255,${(.08 + .6 * v.upd[i]).toFixed(3)})`; c.lineWidth = 1; c.beginPath(); c.arc(x, y, L.mem.cell * .47, 0, 7); c.stroke(); });
  const metres = [v.out[0] * 6, v.out[1] * 6, v.out[2] * 6];
  L.outs.forEach(([x, y], k) => {
    c.fillStyle = tint(v.out[k], .15); c.beginPath(); c.arc(x, y, 9, 0, 7); c.fill();
    c.fillStyle = '#c9d6e3'; c.font = '12px system-ui';
    c.fillText(`${net.outputs[k]}  ${k < 3 ? (metres[k] >= 0 ? '+' : '') + metres[k].toFixed(1) + ' m' : v.out[k].toFixed(2)}`, x + 15, y + 4);
  });
  // Labels.
  c.fillStyle = '#7f95aa'; c.font = '11px system-ui';
  L.inputs.forEach(b => c.fillText({ ego: 'own car (44)', tyres: 'tyres (4 × 8)', road: 'road ahead (12 points × 12)', rivals: 'rivals (8 slots × 18)' }[b.name], b.x, b.y - 3));
  c.fillText('encoder: own context (64)', L.own.x, L.own.y - 3); c.fillText('rivals, pooled mean (32)', L.mean.x, L.mean.y - 3); c.fillText('rivals, pooled max (32)', L.max.x, L.max.y - 3);
  c.fillText('GRU memory (64), ring = holding', L.mem.x, L.mem.y - 3); c.fillText('intent layer (64)', L.hid.x, L.hid.bottom + 12); c.fillText('plan outputs', L.outs[0][0] - 9, L.mem.y - 3);
  c.fillStyle = '#5d7489'; c.fillText('amber = positive · blue = negative · lines: strongest live contributions (weight × activation)', 10, h - 4);
  if (hover) { const [x, y] = hover.pt; c.strokeStyle = '#ffffff'; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, 7, 0, 7); c.stroke(); }
}

// Nearest neuron to (x, y): {pt, text} for the info line.
export function pick(net, L, n, x, y) {
  if (!n) return null;
  const v = frameValues(n); let best = null, d0 = 12 * 12;
  const test = (pts, label, vals) => pts.forEach((p, i) => { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < d0) { d0 = d; best = { pt: p, text: `${label(i)} = ${vals[i].toFixed(2)}` }; } });
  test(L.obs, i => `input ${i} · ${net.fields[i]}`, v.obs);
  test(L.own.pts, i => `own-context unit ${i}`, v.own); test(L.mean.pts, i => `rival mean-pool unit ${i}`, v.mean); test(L.max.pts, i => `rival max-pool unit ${i}`, v.max);
  test(L.mem.pts, i => `memory unit ${i} (update gate ${v.upd[i].toFixed(2)})`, v.mem); test(L.hid.pts, i => `intent unit ${i}`, v.hid);
  test(L.outs, i => net.outputs[i], v.out);
  return best;
}

// Latest decision at or before time t (decisions are sparser than the 20 Hz frames).
export function at(neurons, t) {
  if (!neurons?.length) return null;
  let lo = 0, hi = neurons.length - 1;
  if (neurons[0].t > t) return neurons[0];
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (neurons[mid].t <= t) lo = mid; else hi = mid - 1; }
  return neurons[lo];
}
