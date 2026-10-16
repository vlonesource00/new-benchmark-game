// SLIPSTREAM viewer: header job bar and the "Training & tests" view (tabs: overview, training now, races, models, lap tests, network), fed by /api/status every 5 s.
(() => {
  const $ = (id) => document.getElementById(id);
  const fmtMin = (m) => m == null ? '' : m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min` : `${Math.round(m)} min`;
  const pct = (p) => `${Math.round(100 * p)}%`;
  const kfmt = (n) => n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(2) + ' M' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' k' : String(n);
  let netOn = false, ST = null;

  function setNet(on) { netOn = on; store.set('net', on ? '1' : '0'); $('net').classList.toggle('on', on); $('netBtn').classList.toggle('on', on); document.body.classList.toggle('panel', on); $('netBtn').textContent = on ? 'Replay viewer' : 'Training & tests'; dispatchEvent(new Event('resize')); $('netBtn').blur(); if (on && ST) draw(); }
  $('netBtn').onclick = () => setNet(!netOn);
  $('job').onclick = () => setNet(true);

  // Block diagram: B = [id, x, y, w, title, dims, params, class]; links = [from, side, to, side, dashed]; sides l/r/t/b.
  function diagram(B, links, extra = '') {
    const pos = Object.fromEntries(B.map((b) => [b[0], b])), h = 62;
    const at = (id, side) => { const b = pos[id]; return side === 'r' ? [b[1] + b[3], b[2] + h / 2] : side === 'l' ? [b[1], b[2] + h / 2] : side === 'b' ? [b[1] + b[3] / 2, b[2] + h] : [b[1] + b[3] / 2, b[2]]; };
    const link = ([a, as, b, bs, dash]) => { const [x1, y1] = at(a, as), [x2, y2] = at(b, bs), v = as === 't' || as === 'b'; const c = v ? `${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2}` : `${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2}`; return `<path${dash ? ' class="dash"' : ''} d="M${x1},${y1} C${c} ${x2},${y2}"/>`; };
    let svg = '<defs><marker id="arw" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#4a5462" stroke="none"/></marker></defs>';
    svg += links.map(link).join('') + extra;
    for (const [, bx, by, w, t, d, p, cls] of B)
      svg += `<g class="blk ${cls ?? ''}"><rect x="${bx}" y="${by}" width="${w}" height="${h}" rx="6"/><text x="${bx + 10}" y="${by + 20}">${t}</text><text class="d" x="${bx + 10}" y="${by + 37}">${d}</text>${p ? `<text class="d" x="${bx + 10}" y="${by + 53}">${typeof p === 'number' ? kfmt(p) + ' params' : p}</text>` : ''}</g>`;
    return svg;
  }

  // The pace actor (both networks in the game share it). The critic exists only in training.
  function archSvg(n) {
    const L = n.layout, sh = n.shapes, H = n.hidden, P = n.blocks, o = (k) => sh[k]?.[0];
    const ctx = L.egoX ? ` + ${L.egoX} race context` : '', rctx = L.rivalX ? ` + ${L.rivalX}` : '';
    const B = [
      ['in_e', 10, 30, 150, 'Ego state', `${L.ego}${ctx} features`, null, 'io'],
      ['in_r', 10, 120, 150, 'Road preview', `${L.roadK} points × ${L.roadF}`, null, 'io'],
      ['in_v', 10, 210, 150, 'Rivals', `${L.rivalN} cars × ${L.rivalF}${rctx}`, null, 'io'],
      ['ego', 200, 30, 150, 'Ego MLP', `${sh['ego.0.weight']?.[1]} → ${o('ego.0.weight')} → ${o('ego.2.weight')}`, P.ego],
      ['road', 200, 120, 150, 'Road MLP', `${L.roadK * L.roadF} → ${o('road.0.weight')} → ${o('road.2.weight')}`, P.road],
      ['tok', 200, 210, 150, 'Rival tokens', `${sh['tok.0.weight']?.[1]} → ${o('tok.0.weight')} → ${o('tok.2.weight')} + null`, (P.tok ?? 0) + (P.null ?? 0)],
      ['att', 390, 165, 165, 'Attention', '4 heads · query = ego+road', (P.attn ?? 0) + (P.query ?? 0)],
      ['pre', 390, 65, 165, 'Fuse', `${sh['pre.0.weight']?.[1]} → ${o('pre.0.weight')}`, P.pre],
      ['gru', 595, 65, 160, 'GRU memory', `${H} units · steps on decisions`, P.gru, 'mem'],
      ['pi', 795, 65, 170, 'Policy head', `${sh['pi.0.weight']?.[1]} → ${o('pi.0.weight')} → 2`, P.pi],
      ['out', 795, 185, 170, 'Controls', 'steer · pedal in ±1', null, 'out'],
      ['crit', 595, 255, 160, 'Critic · training only', 'task value + risk value', `${sh['pi.0.weight']?.[1]} → 256 → 1, twice`, 'io'],
    ];
    const links = [['in_e', 'r', 'ego', 'l'], ['in_r', 'r', 'road', 'l'], ['in_v', 'r', 'tok', 'l'], ['ego', 'r', 'pre', 'l'], ['road', 'r', 'pre', 'l'],
      ['road', 'r', 'att', 'l'], ['tok', 'r', 'att', 'l'], ['att', 't', 'pre', 'b'], ['pre', 'r', 'gru', 'l'], ['gru', 'r', 'pi', 'l'], ['pi', 'b', 'out', 't'], ['gru', 'b', 'crit', 't', true]];
    const sx = 390 + 120, ex = 795 + 40;
    return diagram(B, links, `<path d="M${sx},65 C${sx},14 ${ex},14 ${ex},65"/><text class="d" x="603" y="22">skip: fused features also feed the head</text>`);
  }

  // The combat network: a residual mixture of experts around a frozen pace expert.
  function moeSvg(n) {
    const L = n.layout, gs = n.gate.shapes, obs = L.ego + L.roadK * L.roadF + L.rivalN * L.rivalF + (L.egoX ?? 0) + L.rivalN * (L.rivalX ?? 0);
    const B = [
      ['in', 10, 110, 175, 'Observation', `${obs} values`, L.egoX ? `race context: ego +${L.egoX}, rivals +${L.rivalX}` : null, 'io'],
      ['base', 225, 30, 215, 'Pace expert · frozen', 'the pace actor, own normaliser', n.base.params],
      ['cmb', 225, 190, 215, 'Combat expert · trained', `same shape, own ${n.expertHidden}-unit memory`, n.cmb.params, 'mem'],
      ['gate', 480, 190, 170, 'Router', `${gs['0.weight']?.[1]} → ${gs['0.weight']?.[0]} → 1 · sigmoid g`, n.gate.params],
      ['mix', 690, 110, 150, n.residual ? 'Residual mix' : 'Blend', n.residual ? 'pace + g × correction' : '(1 − g) pace + g combat', 'g in [0, 1]'],
      ['out', 870, 110, 100, 'Controls', 'steer · pedal', null, 'out'],
      ['crit', 480, 290, 170, 'Critic · training only', 'reads the combat expert', 'task + risk value', 'io'],
      ['intent', 10, 290, 175, 'Maneuver intent · planned', 'picks a maneuver ~5 times/s', 'conditions the combat expert', 'io plan'],
    ];
    const links = [['in', 'r', 'base', 'l'], ['in', 'r', 'cmb', 'l'], ['base', 'r', 'mix', 'l'], ['cmb', 'r', 'gate', 'l'], ['gate', 't', 'mix', 'b'],
      ['mix', 'r', 'out', 'l'], ['cmb', 'b', 'crit', 'l', true], ['intent', 'r', 'cmb', 'b', true]];
    return diagram(B, links, '<path d="M440,205 C580,205 600,160 690,160"/><text class="d" x="452" y="180">correction (its policy head)</text>');
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
  let tab = store.get('tab', 'over');
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

  // ---- overview: winners board (the JSON block in index.html) + what is running now ------------------
  const BOARD = (() => { try { return JSON.parse($('board').textContent); } catch { return null; } })();
  const BADGE = { game: ['game', 'In the game'], test: ['test', 'Best in tests · not in the game'], wait: ['wait', 'Waiting for results'] };
  const ACT_NOUN = { train: 'Training', lap: 'Lap test', bench: 'Races', drill: 'Drill', follow: 'Following test', other: '' };
  const ACT_GROUP = { pipeline: 'Pipelines', train: 'Training', lap: 'Lap tests', bench: 'Race benchmarks', drill: 'Combat drills', follow: 'Combat drills', other: 'Other jobs' };
  function drawOverview(s) {
    // Everything running now, grouped by type (server process scan), then the next queued jobs.
    const ACT = s.activity ?? { items: [] }, Q = (s.active ?? []).filter((j) => j.state === 'queued').slice(0, 4);
    const groups = ACT.items.reduce((m, a) => { const g = ACT_GROUP[a.kind] ?? ACT_GROUP.other; (m[g] ??= []).push(a); return m; }, {});
    const row = (a) => `<div class="act"><div class="an"><b>${esc(a.name ?? a.kind)}</b>${a.title ? `<span class="ev"> ${what({ run: a.name, title: a.title })}</span>` : ''}${a.detail ? `<div class="ev">${esc(a.detail)}</div>` : ''}</div>`
      + `${a.progress != null ? `<div class="bar"><i style="width:${pct(Math.min(1, a.progress))}"></i></div><span class="x">${pct(Math.min(1, a.progress))}</span>` : '<span></span><span></span>'}<span class="x">running ${fmtMin(a.elapsedMin)}${a.etaMin != null ? ` · ${fmtMin(a.etaMin)} left` : ''}</span></div>`;
    const body = Object.values(ACT_GROUP).filter((g, k, all) => all.indexOf(g) === k && groups[g]).map((g) => `<h4>${g}</h4>${groups[g].map(row).join('')}`).join('');
    const empty = ACT.ok === false ? 'Scanning processes…' : 'Nothing running.';
    $('overNow').innerHTML = `${BOARD?.now ? `<p>${esc(BOARD.now)}</p>` : ''}${body || `<p class="ev">${empty}</p>`}`
      + (Q.length ? `<h4>Queued next</h4>${Q.map((j) => `<div class="act"><div class="an"><span class="ev">${esc(j.title)}</span></div><span></span><span></span><span></span></div>`).join('')}` : '');
    if (!BOARD) { $('overWins').innerHTML = '<p class="ev">No winners board in index.html.</p>'; return; }
    $('overAsOf').textContent = `as of ${BOARD.asOf}`;
    $('overWins').innerHTML = BOARD.winners.map((w) => { const [cls, label] = BADGE[w.badge] ?? ['', w.badge];
      return `<div class="win"><span class="cat">${esc(w.cat)}</span><span class="who">${esc(w.who)}<span class="code">${esc(w.code)}</span></span><span class="badge ${cls}">${esc(label)}</span>`
        + `<ul>${w.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul><span class="why">${esc(w.why)}</span></div>`; }).join('');
    $('overNext').innerHTML = BOARD.next.map((n) => `<li>${esc(n)}</li>`).join('');
    $('overGloss').innerHTML = BOARD.glossary.map(([k, v]) => `<b>${esc(k)}</b><span>${esc(v)}</span>`).join('');
  }

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

  // ---- races: the scoreboard (env/racebench.mjs short, seeds 1-5) -------------------------------------
  // Columns: value, label, better direction (+1 higher is better, -1 lower), format. Compared with the first row (d6, in the game).
  const TRACKS = ['harbor-ring', 'solenne', 'alpine', 'desert'];
  const RCOLS = [[(r) => r.sls.place, 'avg place', -1, (v) => v.toFixed(2)], [(r) => r.sls.wins, 'wins', 1, String],
    [(r) => r.sls.mvPasses, 'real maneuver passes', 1, (v) => v.toFixed(2)], [(r) => r.sls.passes, 'all passes', 1, (v) => v.toFixed(2)],
    [(r) => r.sls.passedBy, 'passed by others', -1, (v) => v.toFixed(2)], [(r) => r.sls.inc, 'incident pts', -1, (v) => v.toFixed(1)],
    [(r) => r.sls.dmg, 'damage %', -1, (v) => v.toFixed(1)], [(r) => r.sls.offS, 'off-track s', -1, (v) => v.toFixed(1)],
    ...TRACKS.map((t) => [(r) => r.perTrack?.[t], `place ${t.replace('-ring', '')}`, -1, (v) => v.toFixed(1)])];
  function drawRaces(s) {
    const R = s.races ?? [], base = R.find((r) => r.state === 'done');
    const cell = (r, [f, , dir, fmt]) => {
      const v = r.state === 'done' ? f(r) : null; if (v == null) return '<td class="dim">–</td>';
      const b = base && r !== base ? f(base) : null, cls = b != null && v !== b ? ((v - b) * dir > 0 ? 'better' : 'worse') : '';
      return `<td class="${cls}">${fmt(v)}</td>`;
    };
    $('raceBody').innerHTML = `<table class="grid"><tr><th>driver</th><th>what it is</th>${RCOLS.map((c) => `<th>${c[1]}</th>`).join('')}</tr>` + R.map((r) =>
      `<tr class="${r === base ? 'baserow' : ''}"><td><b>${esc(r.who)}</b></td><td class="dim">${esc(r.what)}${r.state === 'done' ? '' : ' <span class="ev">· not raced yet</span>'}</td>${RCOLS.map((c) => cell(r, c)).join('')}</tr>`).join('') + '</table>';
  }

  // ---- reliability -------------------------------------------------------------------------------------
  const rcls = (c, of) => !of ? '' : c >= 0.9 * of ? 'ok' : c >= 0.7 * of ? 'mid' : 'low';
  // The name's variant tags (rng2, noise, traffic...) follow the test; '2lap' repeats the lap count and is dropped.
  const variant = (g) => (g.variant ?? '').split('-').filter((x) => x && !/^\d+lap$/.test(x)).join(' ');
  const testKind = (g) => `${g.laps} lap${g.laps > 1 ? 's' : ''}${g.ai ? ' · with ' + esc(g.ai) : ' · solo'} · ${Object.keys(g.tracks).join(', ')}${variant(g) ? ' · ' + esc(variant(g)) : ''}`;
  function drawRel(s) {
    const f = $('relFilter').value.trim().toLowerCase();
    let G = (s.reliability ?? []).filter((g) => !f || `${g.run} ${snapName(g.snap)} ${g.variant ?? ''} ${Object.keys(g.tracks).join(' ')}`.toLowerCase().includes(f));
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
    const combat = (e) => { const r = e.races?.at(-1); return r ? `place ${r.sls.place.toFixed(2)} · ${r.sls.wins} wins` : '<span class="ev">–</span>'; };
    $('exp').innerHTML = '<tr><th>run</th><th>status</th><th>length</th><th>what it tested</th><th>best lap test</th><th>races</th></tr>' + E.map((e) => {
      const open = UI.open.has(e.run);
      const detail = open ? `<tr class="detail"><td colspan="6">
        <div class="trow"><span>from <b>${esc(e.resume ?? 'scratch')}</b></span><span>config <b>${esc(e.config ?? '')}</b></span><span>samples <b>${kfmt(e.samples)}</b></span><span>final reward <b>${e.rew?.toFixed(4) ?? '–'}</b></span>${e.moe ? '<span><b>mixture of experts</b></span>' : ''}</div>
        ${e.reliability.length ? `<div class="chips">${e.reliability.map((g) => `<span class="chip ${rcls(g.total, g.of)}">${snapName(g.snap)} ${g.total}/${g.of} <span class="ev">(${Object.entries(g.seeds).map(([k, v]) => `s${k} ${v[0]}`).join(' · ')}) ${g.laps}-lap${g.ai ? ' · ai' : ''}</span></span>`).join('')}</div>` : '<p class="ev">No reliability results.</p>'}
        </td></tr>` : '';
      return `<tr data-run="${esc(e.run)}" class="exprow ${open ? 'open' : ''}"><td><b>${esc(e.run)}</b></td><td><span class="st ${e.state}">${e.state}</span></td><td class="dim">${e.state === 'queued' ? '' : `${fmtMin(e.elapsed)}${e.minutes && e.state !== 'done' ? ' / ' + fmtMin(e.minutes) : ''}`}</td>
        <td class="what">${what(e)}</td><td>${best(e)}</td><td>${combat(e)}</td></tr>${detail}`;
    }).join('');
    $('expMore').hidden = !!f || n <= 12; $('expMore').textContent = UI.expAll ? 'Show newest 12' : `Show all ${n}`;
  }

  function draw() {
    const s = ST, N = s.networks ?? {};
    $('jobsLabel').textContent = s.label ?? '';
    if (tab === 'netw' && N.main) {
      const card = (n, game) => `<div class="netc${game ? '' : ' test'}"><div class="r">${n.role}</div><b>${n.ckpt.replace(/^runs\//, '').replace(/\.pt$/, '')}</b>`
        + `<span>iteration ${n.iter} · ${kfmt(n.params)} params${n.moe ? ' (two experts + router)' : ''}</span><span>${game ? 'in the game since' : 'exported'} ${new Date(n.updated).toLocaleString()}</span></div>`;
      $('netInfo').innerHTML = card(N.main, true) + (N.nurb ? card(N.nurb, true) : '') + (N.combat ? card(N.combat, false) : '');
      const same = N.nurb && JSON.stringify(N.nurb.layout) === JSON.stringify(N.main.layout) && N.nurb.params === N.main.params;
      $('archNote').textContent = `Decides up to 30 times a second; between decisions the last controls are held and the memory does not step.${same ? ' Both networks in the game have this shape, with different weights.' : ''}`;
      $('arch').innerHTML = archSvg(N.main);
      // The two-expert diagram: the game's own network when it is one, else the one in test.
      const mo = N.main.moe ? N.main : N.combat?.moe ? N.combat : null;
      $('moeWrap').hidden = !mo;
      if (mo) { $('moeTitle').textContent = mo === N.main ? 'Combat add-on (in the game)' : 'Combat add-on (in test)'; $('moe').innerHTML = moeSvg(mo); }
    }
    if (tab === 'over') drawOverview(s);
    if (tab === 'live') drawLive(s);
    if (tab === 'exp') drawExp(s);
    if (tab === 'bench') drawRaces(s);
    if (tab === 'rel') drawRel(s);
  }

  async function poll() {
    try {
      ST = await (await fetch('/api/status', { cache: 'no-store' })).json();
      // Header: what is running now (process scan), the first job with a progress bar; else the queue's current job.
      const acts = (ST.activity?.items ?? []).filter((a) => a.kind !== 'pipeline'), lead = acts.find((a) => a.progress != null);
      const c = acts.length ? null : ST.current;
      const eta = Math.max(-1, ...acts.map((a) => a.etaMin ?? -1));
      $('jobT').textContent = acts.length ? acts.map((a) => `${ACT_NOUN[a.kind] ?? ''} ${a.name ?? ''}`.trim()).join(' · ') + (eta >= 0 ? ` · ${fmtMin(eta)} left` : '')
        : c ? `${c.state === 'queued' ? 'Next: ' : ''}${c.title}${c.etaMin ? ` · ${fmtMin(c.etaMin)} left` : ''}` : 'Nothing running';
      const p = lead ? Math.min(1, lead.progress) : c?.state === 'running' ? c.progress : null;
      $('jobBar').className = 'bar' + (p == null ? ' q' : '');
      $('jobBar').firstElementChild.style.width = pct(p ?? 0);
      $('jobP').textContent = p == null ? '' : pct(p);
      if (netOn) draw();
    } catch { $('jobT').textContent = 'status unavailable'; }
  }
  // The page reopens where it was left: the overview by default, the replay once the panel is closed.
  if (store.get('net', '1') === '1') setNet(true);
  poll(); setInterval(poll, 5000);
  addEventListener('resize', () => { if (netOn && ST) draw(); });
})();
