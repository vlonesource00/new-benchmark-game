// SLIPSTREAM viewer: header job bar and the "Training & tests" view (tabs: live training, experiments, combat benchmarks, reliability, network), fed by /api/status every 5 s.
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
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = { get(k, d) { try { return localStorage.getItem('slp.' + k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem('slp.' + k, v); } catch {} } };
  // A training title reads "Train <run> — what it tests — outcome notes": the run name is its own column.
  const what = (e) => esc(e.title.replace(new RegExp(`^Train ${e.run}\\s*[—-]?\\s*`), ''));
  const snapName = (s) => s === 'final' ? 'final' : s == null ? '' : `@${s}`;

  // ---- tabs ------------------------------------------------------------------------------------
  let tab = store.get('tab', 'live');
  const UI = { expAll: false, relAll: false, open: new Set() };
  function setTab(t) {
    tab = t; store.set('tab', t);
    for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === t);
    for (const s of document.querySelectorAll('#net section')) s.hidden = s.dataset.tab !== t;
    if (ST) draw();
  }
  for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => { setTab(b.dataset.tab); b.blur(); };
  $('expFilter').oninput = () => draw(); $('relFilter').oninput = () => draw();
  $('expMore').onclick = () => { UI.expAll = !UI.expAll; draw(); };
  $('relMore').onclick = () => { UI.relAll = !UI.relAll; draw(); };
  $('exp').onclick = (ev) => { const r = ev.target.closest('tr[data-run]'); if (!r) return; const k = r.dataset.run; UI.open.has(k) ? UI.open.delete(k) : UI.open.add(k); draw(); };
  setTab(tab);

  // ---- live training -----------------------------------------------------------------------------
  function drawLive(s) {
    const A = s.active ?? [], C = s.counts ?? {};
    $('liveJobs').innerHTML = A.length ? A.map((j) => {
      const extra = j.kind === 'train' ? (j.state === 'running' ? `${fmtMin(j.elapsed)} / ${fmtMin(j.minutes)} · ${fmtMin(j.etaMin)} left` : `${fmtMin(j.minutes)}`)
        : j.detail ? `${j.detail.done}/${j.detail.total} attempts · ${j.detail.complete} ok` : '';
      return `<span class="st ${j.state}">${j.state}</span><span class="jt">${esc(j.title)}</span><div class="bar ${j.state === 'queued' ? 'q' : ''}"><i style="width:${pct(j.progress)}"></i></div><span class="x">${extra}</span>`;
    }).join('') : '<span class="ev" style="grid-column:1/-1">Nothing running or queued.</span>';
    $('liveCounts').textContent = `${C.done ?? 0} finished · ${C.stopped ?? 0} stopped early · ${C.skipped ?? 0} skipped — see Experiments`;
    const T = s.trainings ?? [];
    $('liveTitle').textContent = s.live ? (T.length > 1 ? `${T.map((t) => t.run).join(' vs ')} · curves by samples collected` : T[0]?.run ?? '')
      : T[0] ? `nothing training · last run ${T[0].run} (${T[0].state})` : 'nothing training';
    if (!T.length) { $('liveInfo').innerHTML = ''; $('curves').innerHTML = ''; return; }
    const many = T.length > 1;
    $('liveInfo').innerHTML = T.map((t, k) => {
      const L = t.latest, recent = t.curve.slice(-20), stopRate = t.updates ? Math.round(100 * t.stopped / t.updates) : 0;
      return `<div class="lcard" style="border-left-color:${RUNCOL[k]}"><div class="lhead"><b>${t.run}</b><span class="st ${t.state}">${t.state}</span>
        <div class="bar ${t.state === 'running' ? '' : 'done'}"><i style="width:${pct(t.progress)}"></i></div><span class="x">${fmtMin(t.elapsed)} / ${fmtMin(t.minutes)}${t.state === 'running' ? ` · ${fmtMin(t.etaMin)} left` : ''}${t.stale && t.state === 'running' ? ' · no log for 2 min' : ''}</span></div>
        <div class="ltitle">${esc(t.title)}</div>
        <div class="trow"><span>from <b>${esc(t.resume ?? 'scratch')}</b></span><span>config <b>${esc(t.config)}</b></span><span>iteration <b>${L.it}</b></span><span>samples <b>${kfmt(L.steps)}</b></span>
        <span>throughput <b>${kfmt(Math.round(recent.reduce((a, r) => a + r[6], 0) / Math.max(1, recent.length)))}/s</b></span><span>reward <b>${L.rew?.toFixed(4)}</b></span>
        ${t.moe ? `<span>router in traffic <b>${pct(L.gate_tr ?? 0)}</b></span><span>router solo <b>${pct(L.gate_solo ?? 0)}</b></span>` : ''}
        <span>exploration floor <b>${t.stdMin ? t.stdMin.replace(',', ' / ') : 'none'}</b></span><span>updates cut short <b>${stopRate}%</b></span><span>decide <b>${(30 * (L.decide ?? 0)).toFixed(1)} Hz</b></span></div></div>`;
    }).join('');
    const anyMoe = T.some((t) => t.moe), want = anyMoe ? 5 : 4;
    if ($('curves').children.length !== want) $('curves').innerHTML = '<canvas></canvas>'.repeat(want);
    const [c1, c2, c3, c4, c5] = $('curves').children;
    const ser = (i, extra = {}) => T.map((t, k) => ({ x: t.curve.map((r) => r[7]), v: t.curve.map((r) => r[i]), c: RUNCOL[k], n: many ? t.run : '', ...extra }));
    curve(c1, 'Reward per decision', ser(2), (v) => v.toFixed(4));
    if (anyMoe) curve(c2, 'Router share to combat expert', [...ser(8).map((x) => ({ ...x, n: `${x.n} traffic`.trim() })), ...ser(9, { dash: true }).map((x) => ({ ...x, n: `${x.n} alone`.trim() }))], (v) => pct(v));
    const rest = anyMoe ? [c3, c4, c5] : [c2, c3, c4];
    curve(rest[0], 'Policy std', [...ser(3).map((x) => ({ ...x, n: `${x.n} steer`.trim() })), ...ser(4, { dash: true }).map((x) => ({ ...x, n: `${x.n} pedal`.trim() }))]);
    curve(rest[1], 'KL per update', ser(5), (v) => v.toFixed(4));
    curve(rest[2], 'Samples / s', ser(6), (v) => kfmt(Math.round(v)));
  }

  // ---- combat benchmarks -----------------------------------------------------------------------------
  // Columns: key, label, better direction (+1 higher is better, -1 lower), format.
  const BCOLS = [['gained', 'places gained', 1], ['passes', 'passes', 1], ['lost', 'places lost', -1], ['rubS', 'rubbing s', -1], ['heavy', 'heavy contacts', -1],
    ['dmg', 'damage', -1], ['meanPos', 'mean finish', -1], ['stuckS', 'stuck s', -1]];
  const BENCH_INFO = {
    duel3: 'Mid-race combat: 24 races, 2 laps on the Nürburgring. SLIPSTREAM is held on the grid 3–13 s, then must fight back through 3 AIs (INTERCEPT / RAZOR). Deployment gate: at least the specialist\'s places gained with less rubbing and damage.',
    duel2: 'Earlier, smaller combat benchmark (8 races). Superseded by duel3.'
  };
  const verdict = (r, base) => {
    if (!base || r === base) return r === base ? '<span class="tag base">baseline</span>' : '';
    const m = r.metrics, b = base.metrics, ok = m.gained >= b.gained && m.rubS < b.rubS && m.dmg < b.dmg;
    return ok ? '<span class="tag good">passes gate</span>' : '<span class="tag">below gate</span>';
  };
  function benchTable(rows, base) {
    const cell = (r, [k, , dir]) => {
      const v = r.metrics[k]; if (v == null) return '<td></td>';
      const b = base?.metrics[k], cls = base && r !== base && b != null && v !== b ? ((v - b) * dir > 0 ? 'better' : 'worse') : '';
      return `<td class="${cls}">${typeof v === 'number' ? +v.toFixed(2) : esc(v)}</td>`;
    };
    return `<table class="grid"><tr><th>model</th><th>checkpoint</th>${BCOLS.map((c) => `<th>${c[1]}</th>`).join('')}<th></th></tr>` + rows.map((r) =>
      `<tr class="${r === base ? 'baserow' : ''}"><td><b>${esc(r.model)}</b></td><td class="dim">${r.run ? esc(r.run) + ' ' + snapName(r.snap) : ''}${r.note ? ` <span class="ev">${esc(r.note)}</span>` : ''}</td>${BCOLS.map((c) => cell(r, c)).join('')}<td>${verdict(r, base)}</td></tr>`).join('') + '</table>';
  }
  function drawBench(s) {
    const B = s.benchmarks ?? [], names = [...new Set(B.map((b) => b.bench))].sort().reverse();
    $('benchBody').innerHTML = names.length ? names.map((n) => {
      const rows = B.filter((b) => b.bench === n), base = [...rows].reverse().find((r) => r.model === 'spec');
      return `<h3>${n}</h3><p class="ev">${BENCH_INFO[n] ?? ''} Green / red: better / worse than the baseline.</p><div class="scroll">${benchTable(rows, base)}</div>`;
    }).join('') : '<p class="ev">No benchmark recorded yet.</p>';
  }

  // ---- reliability -------------------------------------------------------------------------------------
  const rcls = (c, of) => !of ? '' : c >= 0.9 * of ? 'ok' : c >= 0.7 * of ? 'mid' : 'low';
  const testKind = (g) => `${g.laps} lap${g.laps > 1 ? 's' : ''}${g.ai ? ' · with ' + esc(g.ai) : ' · solo'} · ${Object.keys(g.tracks).join(', ')}`;
  function drawRel(s) {
    const f = $('relFilter').value.trim().toLowerCase();
    let G = (s.reliability ?? []).filter((g) => !f || `${g.run} ${snapName(g.snap)} ${Object.keys(g.tracks).join(' ')}`.toLowerCase().includes(f));
    const n = G.length; if (!UI.relAll && !f) G = G.slice(0, 25);
    const seeds = [...new Set(G.flatMap((g) => Object.keys(g.seeds)))].sort();
    $('rel').innerHTML = `<tr><th>checkpoint</th><th>test</th>${seeds.map((x) => `<th>seed ${x}</th>`).join('')}<th>total</th><th>finished</th><th>when</th></tr>` + G.map((g) =>
      `<tr><td><b>${esc(g.run)}</b> ${snapName(g.snap)}${g.ema ? ' <span class="ev">avg</span>' : ''}</td><td class="dim">${testKind(g)}</td>${seeds.map((x) => { const v = g.seeds[x]; return v ? `<td class="${rcls(v[0], v[1])}">${v[0]}/${v[1]}</td>` : '<td></td>'; }).join('')}
      <td class="${rcls(g.total, g.of)}"><b>${g.total}/${g.of}</b></td><td>${pct(g.total / Math.max(1, g.of))}</td><td class="dim">${new Date(g.mtime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td></tr>`).join('');
    $('relMore').hidden = !!f || n <= 25; $('relMore').textContent = UI.relAll ? 'Show newest 25' : `Show all ${n}`;
  }

  // ---- experiments -------------------------------------------------------------------------------------
  function drawExp(s) {
    const f = $('expFilter').value.trim().toLowerCase();
    let E = (s.experiments ?? []).filter((e) => !f || `${e.run} ${e.title}`.toLowerCase().includes(f));
    const n = E.length; if (!UI.expAll && !f) E = E.slice(0, 12);
    const best = (e) => { const g = [...e.reliability].filter((x) => x.of).sort((a, b) => b.total / b.of - a.total / a.of)[0]; return g ? `<span class="${rcls(g.total, g.of)}">${g.total}/${g.of}</span> <span class="ev">${snapName(g.snap)}</span>` : '<span class="ev">–</span>'; };
    const combat = (e) => { const d = e.bench.filter((b) => b.bench === 'duel3'); if (!d.length) return '<span class="ev">–</span>'; const b = [...d].sort((x, y) => y.metrics.gained - x.metrics.gained)[0]; return `+${b.metrics.gained} places · rub ${b.metrics.rubS}s <span class="ev">${snapName(b.snap)}</span>`; };
    $('exp').innerHTML = '<tr><th>run</th><th>status</th><th>length</th><th>what it tested</th><th>best reliability</th><th>best combat (duel3)</th></tr>' + E.map((e) => {
      const open = UI.open.has(e.run);
      const detail = open ? `<tr class="detail"><td colspan="6">
        <div class="trow"><span>from <b>${esc(e.resume ?? 'scratch')}</b></span><span>config <b>${esc(e.config ?? '')}</b></span><span>samples <b>${kfmt(e.samples)}</b></span><span>final reward <b>${e.rew?.toFixed(4) ?? '–'}</b></span>${e.moe ? '<span><b>mixture of experts</b></span>' : ''}</div>
        ${e.reliability.length ? `<div class="chips">${e.reliability.map((g) => `<span class="chip ${rcls(g.total, g.of)}">${snapName(g.snap)} ${g.total}/${g.of} <span class="ev">(${Object.entries(g.seeds).map(([k, v]) => `s${k} ${v[0]}`).join(' · ')}) ${g.laps}-lap${g.ai ? ' · ai' : ''}</span></span>`).join('')}</div>` : '<p class="ev">No reliability results.</p>'}
        ${e.bench.length ? benchTable(e.bench, null) : ''}</td></tr>` : '';
      return `<tr data-run="${esc(e.run)}" class="exprow ${open ? 'open' : ''}"><td><b>${esc(e.run)}</b></td><td><span class="st ${e.state}">${e.state}</span></td><td class="dim">${e.state === 'queued' ? '' : `${fmtMin(e.elapsed)}${e.minutes && e.state !== 'done' ? ' / ' + fmtMin(e.minutes) : ''}`}</td>
        <td class="what">${what(e)}</td><td>${best(e)}</td><td>${combat(e)}</td></tr>${detail}`;
    }).join('');
    $('expMore').hidden = !!f || n <= 12; $('expMore').textContent = UI.expAll ? 'Show newest 12' : `Show all ${n}`;
  }

  function draw() {
    const s = ST, n = s.network;
    $('jobsLabel').textContent = s.label ?? '';
    if (tab === 'netw' && n) {
      $('netInfo').innerHTML = `<span>checkpoint <b>${n.ckpt}</b></span><span>iteration <b>${n.iter}</b></span><span>parameters <b>${kfmt(n.params)}</b></span><span>decides <b>up to 30 / s</b></span><span>deployed <b>${new Date(n.updated).toLocaleString()}</b></span>`;
      $('arch').innerHTML = archSvg(n);
    }
    if (tab === 'live') drawLive(s);
    if (tab === 'exp') drawExp(s);
    if (tab === 'bench') drawBench(s);
    if (tab === 'rel') drawRel(s);
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
