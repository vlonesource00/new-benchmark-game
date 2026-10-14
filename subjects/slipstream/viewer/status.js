// SLIPSTREAM viewer: header job bar and the "Network & jobs" view, fed by /api/status every 5 s.
(() => {
  const $ = (id) => document.getElementById(id);
  const fmtMin = (m) => m == null ? '' : m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min` : `${Math.round(m)} min`;
  const pct = (p) => `${Math.round(100 * p)}%`;
  const kfmt = (n) => n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(2) + ' M' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' k' : String(n);
  let netOn = false, ST = null;

  function setNet(on) { netOn = on; $('net').classList.toggle('on', on); $('netBtn').classList.toggle('on', on); $('netBtn').blur(); if (on && ST) draw(); }
  $('netBtn').onclick = () => setNet(!netOn);
  $('job').onclick = () => setNet(true);

  function archSvg(n) {
    const L = n.layout, sh = n.shapes, H = n.hidden, P = n.blocks, o = (k) => sh[k]?.[0];
    const B = [ // id, x, y, w, title, dims, params, class
      ['in_e', 10, 30, 150, 'Ego state', `${L.ego} features`, null, 'io'],
      ['in_r', 10, 120, 150, 'Road preview', `${L.roadK} points × ${L.roadF}`, null, 'io'],
      ['in_v', 10, 210, 150, 'Rivals', `${L.rivalN} cars × ${L.rivalF}`, null, 'io'],
      ['ego', 200, 30, 150, 'Ego MLP', `${L.ego} → ${o('ego.0.weight')} → ${o('ego.2.weight')}`, P.ego],
      ['road', 200, 120, 150, 'Road MLP', `${L.roadK * L.roadF} → ${o('road.0.weight')} → ${o('road.2.weight')}`, P.road],
      ['tok', 200, 210, 150, 'Rival tokens', `${L.rivalF} → ${o('tok.0.weight')} → ${o('tok.2.weight')} + null`, (P.tok ?? 0) + (P.null ?? 0)],
      ['att', 390, 165, 165, 'Attention', '4 heads · query = ego+road', (P.attn ?? 0) + (P.query ?? 0)],
      ['pre', 390, 65, 165, 'Fuse', `${sh['pre.0.weight']?.[1]} → ${o('pre.0.weight')}`, P.pre],
      ['gru', 595, 65, 160, 'GRU memory', `${H} units · steps on decisions`, P.gru, 'mem'],
      ['pi', 795, 65, 170, 'Policy head', `${sh['pi.0.weight']?.[1]} → ${o('pi.0.weight')} → 2`, P.pi],
      ['out', 795, 185, 170, 'Controls', 'steer · pedal in ±1', null, 'out'],
    ];
    const pos = Object.fromEntries(B.map((b) => [b[0], b])), h = 62;
    const at = (id, side) => { const b = pos[id]; return side === 'r' ? [b[1] + b[3], b[2] + h / 2] : side === 'l' ? [b[1], b[2] + h / 2] : side === 'b' ? [b[1] + b[3] / 2, b[2] + h] : [b[1] + b[3] / 2, b[2]]; };
    const link = (a, as, b, bs) => { const [x1, y1] = at(a, as), [x2, y2] = at(b, bs), v = as === 't' || as === 'b'; const c = v ? `${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2}` : `${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2}`; return `<path d="M${x1},${y1} C${c} ${x2},${y2}"/>`; };
    let svg = '<defs><marker id="arw" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#4a5462" stroke="none"/></marker></defs>';
    svg += link('in_e', 'r', 'ego', 'l') + link('in_r', 'r', 'road', 'l') + link('in_v', 'r', 'tok', 'l') + link('ego', 'r', 'pre', 'l') + link('road', 'r', 'pre', 'l')
      + link('road', 'r', 'att', 'l') + link('tok', 'r', 'att', 'l') + link('att', 't', 'pre', 'b') + link('pre', 'r', 'gru', 'l') + link('gru', 'r', 'pi', 'l') + link('pi', 'b', 'out', 't');
    const sx = pos.pre[1] + 120, ex = pos.pi[1] + 40;
    svg += `<path d="M${sx},${pos.pre[2]} C${sx},14 ${ex},14 ${ex},${pos.pi[2]}"/><text class="d" x="${pos.gru[1] + 8}" y="22">skip: fused features also feed the head</text>`;
    for (const [, bx, by, w, t, d, p, cls] of B)
      svg += `<g class="blk ${cls ?? ''}"><rect x="${bx}" y="${by}" width="${w}" height="${h}" rx="6"/><text x="${bx + 10}" y="${by + 20}">${t}</text><text class="d" x="${bx + 10}" y="${by + 37}">${d}</text>${p ? `<text class="d" x="${bx + 10}" y="${by + 53}">${kfmt(p)} params</text>` : ''}</g>`;
    svg += `<text class="d" x="595" y="285">The value head (critic) exists only in training; the game runs this actor.</text>`;
    return svg;
  }

  // Series share both axes: x is samples collected (s.x), so parallel arms line up by practice, not wall time.
  // Latest values are listed top right, one line per series; dashed series use s.dash.
  function curve(c, title, series, fmt = (v) => v.toFixed(3)) {
    const d = devicePixelRatio, w = c.clientWidth * d, h = c.clientHeight * d; c.width = w; c.height = h;
    const g = c.getContext('2d'), pad = 6 * d, lh = 12 * d, top = (8 + 12 * Math.max(1, series.length)) * d;
    const ys = series.flatMap((s) => s.v).filter(Number.isFinite), xs = series.flatMap((s) => s.x).filter(Number.isFinite); if (!ys.length) return;
    let lo = Math.min(...ys), hi = Math.max(...ys); if (hi - lo < 1e-9) { hi += 1e-3; lo -= 1e-3; }
    const x0 = Math.min(...xs), x1 = Math.max(...xs) || 1;
    g.font = `${11 * d}px system-ui`; g.fillStyle = '#8a94a2'; g.fillText(title, pad, 13 * d);
    series.forEach((s, k) => {
      g.strokeStyle = s.c; g.lineWidth = 1.5 * d; g.setLineDash(s.dash ? [4 * d, 3 * d] : []); g.beginPath(); let started = false;
      s.v.forEach((v, i) => { if (!Number.isFinite(v)) return; const X = pad + (w - 2 * pad) * (s.x[i] - x0) / Math.max(1, x1 - x0), Y = top + (h - top - pad) * (1 - (v - lo) / (hi - lo)); started ? g.lineTo(X, Y) : g.moveTo(X, Y); started = true; });
      g.stroke(); g.setLineDash([]);
      const last = s.v.filter(Number.isFinite).at(-1); g.fillStyle = s.c; g.textAlign = 'right';
      g.fillText(`${s.n ? s.n + ' ' : ''}${fmt(last)}`, w - pad, 13 * d + k * lh); g.textAlign = 'left';
    });
  }
  const RUNCOL = ['#8ab4ff', '#f2b84b', '#4cc38a', '#ff5a4e'];

  function draw() {
    const s = ST, n = s.network;
    if (n) {
      $('netInfo').innerHTML = `<span>checkpoint <b>${n.ckpt}</b></span><span>iteration <b>${n.iter}</b></span><span>parameters <b>${kfmt(n.params)}</b></span><span>decides <b>up to 30 / s</b></span><span>deployed <b>${new Date(n.updated).toLocaleString()}</b></span>`;
      $('arch').innerHTML = archSvg(n);
    }
    $('jobsLabel').textContent = s.label ? `· ${s.label} · overall ${pct(s.overall)}` : '';
    $('jobs').innerHTML = s.jobs.map((j) => {
      const extra = j.kind === 'train'
        ? (j.state === 'queued' ? '' : `${fmtMin(j.elapsed)} / ${fmtMin(j.minutes)}${j.state === 'running' ? ` · ${fmtMin(j.etaMin)} left` : ''}${j.stale ? ' · no log for 2 min' : ''}`)
        : j.state === 'done' ? `${j.total} complete` : j.detail ? `${j.detail.done}/${j.detail.total} attempts · ${j.detail.complete} ok` : '';
      return `<span class="st ${j.state}">${j.state}</span><span>${j.title}</span><div class="bar ${j.state === 'done' ? 'done' : j.state === 'queued' ? 'q' : ''}"><i style="width:${pct(j.progress)}"></i></div><span class="x">${extra}</span>`;
    }).join('');
    const T = s.trainings ?? [];
    if (T.length) {
      const t0 = T[0], many = T.length > 1, nm = (t) => t.run;
      $('trainLabel').textContent = `· ${T.map(nm).join(' vs ')} · ${t0.config} · from ${t0.resume ?? 'scratch'}${many ? ' · curves by samples collected' : ''}`;
      const lat = t0.latency?.frames ? 'frame model ' + t0.latency.frames.map((f) => f[0]).join('/') + ' substeps' : `uniform ${t0.latency?.min}–${t0.latency?.max} substeps`;
      const tr = [...new Set(t0.tracks ?? [])].map((x) => `${x}${t0.tracks.filter((y) => y === x).length > 1 ? ' ×' + t0.tracks.filter((y) => y === x).length : ''}`).join(', ');
      $('trainInfo').innerHTML = T.map((t, k) => {
        const L = t.latest, recent = t.curve.slice(-20), stopRate = t.updates ? Math.round(100 * t.stopped / t.updates) : 0;
        return `<div class="trow"><span style="color:${RUNCOL[k]}"><b>${t.run}</b></span><span>exploration floor <b>${t.stdMin ? t.stdMin.replace(',', ' / ') : 'none'}</b></span><span>iteration <b>${L.it}</b></span><span>samples <b>${kfmt(L.steps)}</b></span><span>throughput <b>${kfmt(Math.round(recent.reduce((a, r) => a + r[6], 0) / Math.max(1, recent.length)))}/s</b></span><span>updates cut short <b>${stopRate}%</b></span><span>decide rate <b>${(30 * (L.decide ?? 0)).toFixed(1)} Hz</b></span></div>`;
      }).join('') + `<div class="trow"><span>latency <b>${lat}</b></span><span>tracks <b>${tr}</b></span></div>`;
      if (!$('curves').children.length) $('curves').innerHTML = '<canvas></canvas><canvas></canvas><canvas></canvas><canvas></canvas>';
      const [c1, c2, c3, c4] = $('curves').children;
      const ser = (i, extra = {}) => T.map((t, k) => ({ x: t.curve.map((r) => r[7]), v: t.curve.map((r) => r[i]), c: RUNCOL[k], n: many ? t.run : '', ...extra }));
      curve(c1, 'Reward per decision', ser(2), (v) => v.toFixed(4));
      curve(c2, 'Policy std', [...ser(3).map((x) => ({ ...x, n: `${x.n} steer`.trim() })), ...ser(4, { dash: true }).map((x) => ({ ...x, n: `${x.n} pedal`.trim() }))]);
      curve(c3, 'KL per update', ser(5), (v) => v.toFixed(4));
      curve(c4, 'Samples / s', ser(6), (v) => kfmt(Math.round(v)));
    }
    const tracks = [...new Set(s.results.flatMap((r) => Object.keys(r.tracks)))];
    const cls = (c, of) => c >= 0.9 * of ? 'ok' : c >= 0.5 * of ? 'mid' : 'low';
    $('res').innerHTML = `<tr><th>checkpoint</th>${tracks.map((x) => `<th>${x}</th>`).join('')}<th>total</th></tr>` + s.results.map((r) => `<tr><td>${r.name}</td>${tracks.map((x) => {
      const v = r.tracks[x]; return v ? `<td class="${cls(v[0], v[1])}">${v[0]}/${v[1]}${v[2] != null ? ` <span class="ev">+${v[2]}%</span>` : ''}</td>` : '<td></td>';
    }).join('')}<td><b>${r.total}/${r.of}</b></td></tr>`).join('');
  }

  async function poll() {
    try {
      ST = await (await fetch('/api/status', { cache: 'no-store' })).json();
      const c = ST.current;
      $('jobT').textContent = c ? `${c.title}${c.etaMin ? ` · ${fmtMin(c.etaMin)} left` : ''}` : 'No jobs running';
      $('jobBar').className = 'bar' + (c ? '' : ' done');
      $('jobBar').firstElementChild.style.width = pct(c ? c.progress : 1);
      $('jobP').textContent = c ? pct(c.progress) : '';
      if (netOn) draw();
    } catch { $('jobT').textContent = 'status unavailable'; }
  }
  poll(); setInterval(poll, 5000);
  addEventListener('resize', () => { if (netOn && ST) draw(); });
})();
