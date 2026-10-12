// Jobs page: polls /api/jobs and draws one progress bar per job (shards grouped).
const root = document.getElementById('jobs'), scope = document.getElementById('scope');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const span = ms => {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
};
const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const count = n => Number.isInteger(n) ? n : n.toFixed(1);

function spark(history) {
  // Training success per iteration; dev evaluations as dots on the same 0–1 scale.
  const w = 600, h = 70, n = Math.max(history.length, 2), x = i => 4 + i / (n - 1) * (w - 8), y = v => h - 6 - v * (h - 12);
  const line = history.map((e, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(e.success).toFixed(1)}`).join('');
  const dots = history.filter(e => e.dev).map(e => `<circle cx="${x(history.indexOf(e))}" cy="${y(e.dev.ok / e.dev.total)}" r="4" fill="#ffd166"><title>dev ${e.dev.ok}/${e.dev.total} at iteration ${e.iteration}</title></circle>`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${line}" fill="none" stroke="#50d4b6" stroke-width="2" vector-effect="non-scaling-stroke"/>${dots}</svg>
    <div class="nums"><span><i style="color:#50d4b6">—</i> train-rollout success</span><span><i style="color:#ffd166">●</i> development success</span></div>`;
}

function card(j, now) {
  const fraction = j.total ? Math.min(1, j.done / j.total) : 0, elapsed = j.start == null ? NaN : (j.state === 'running' ? now : j.updated) - j.start;
  const rate = j.done > 0 && Number.isFinite(elapsed) ? elapsed / j.done : null;
  const shards = j.shards ? `<div class="shards">${j.shards.map(s => `<div>${esc(s.name)} · ${count(s.done)}/${s.total ?? '?'}
    <div class="bar"><i style="width:${s.total ? s.done / s.total * 100 : 0}%"></i></div></div>`).join('')}</div>` : '';
  return `<section class="job ${j.state}"><header><h2>${esc(j.name)} <span>${esc(j.kind)}</span></h2><span class="state">${j.state}</span></header>
    <div class="bar"><i style="width:${(fraction * 100).toFixed(1)}%"></i></div>
    <div class="nums"><span><b>${count(j.done)}</b> / ${j.total ?? '?'} (${(fraction * 100).toFixed(0)}%)</span>
      ${Number.isFinite(elapsed) ? `<span>elapsed <b>${span(elapsed)}</b></span>` : ''}
      ${j.state === 'running' ? `<span>remaining <b>${span(j.eta)}</b></span><span>finishes ≈ <b>${Number.isFinite(j.eta) ? clock(now + j.eta) : '—'}</b></span>` : `<span>last update <b>${clock(j.updated)}</b></span>`}
      ${rate ? `<span>${span(rate)} per unit</span>` : ''}</div>
    ${j.detail ? `<p>${esc(j.detail)}</p>` : ''}${shards}${j.history?.length ? spark(j.history) : ''}</section>`;
}

async function refresh() {
  try {
    const { now, jobs } = await (await fetch('/api/jobs', { cache: 'no-store' })).json();
    const running = jobs.filter(j => j.state === 'running').length;
    scope.textContent = `${running} running · ${jobs.length - running} recent finished or stalled · updated ${clock(now)}`;
    root.innerHTML = jobs.length ? jobs.map(j => card(j, now)).join('') : '<p id="empty">No job has written progress in the last 12 hours.</p>';
  } catch (e) { scope.textContent = 'Job state unavailable: ' + e.message; }
}
refresh(); setInterval(refresh, 5000);
