const $ = id => document.getElementById(id), params = new URLSearchParams(location.search), name = params.get('name') ?? 'c79-complete-review';
if (!/^[a-z0-9-]+$/i.test(name)) throw Error('Invalid audit name');
const response = await fetch('/artifacts/replay-audits/' + name + '/report.json');
if (!response.ok) throw Error('Audit report not found');
const report = await response.json(), fmt = (x, n = 2) => Number.isFinite(x) ? x.toFixed(n) : '—';
if (params.has('find')) $('find').value = params.get('find');
$('scope').textContent = report.scope;
const metric = (label, value) => { const d = document.createElement('div'); d.className = 'metric'; const a = document.createElement('small'), b = document.createElement('strong'); a.textContent = label; b.textContent = value; d.append(a, b); return d; };
$('totals').replaceChildren(metric('Recorded replays', report.episodes.length), metric('Fitted-NN replays', report.episodes.filter(e => e.kind === 'fitted-NN').length), metric('Sampled control trials', report.episodes.filter(e => e.kind === 'offline-search').length), metric('Created', report.createdAt.slice(0, 19).replace('T', ' ')));
function inspect(e) {
  const d = $('detail'); d.replaceChildren(); const title = document.createElement('p'); title.textContent = e.name + ' · ' + (e.model ?? e.kind); d.append(title);
  const facts = document.createElement('p'); facts.textContent = `${e.seconds} s · ${e.retained ?? 0} recorded retained passes · tyre wear spent ${fmt(e.wearSpent * 100)}% · ${fmt(e.line.frontBlockedSeconds)} s near a blocked front · ${fmt(e.line.clearFrontCorrectionSeconds)} s with no car within 50 m ahead and |NN steering correction| > 0.1. These last two are diagnostic observations, not time-loss or blame measurements.`; d.append(facts);
  const setup = document.createElement('pre'); setup.textContent = JSON.stringify({ settings: e.settings, checks: e.violations, fullLaps: e.fullLaps, model: e.modelSha256, source: e.sourceDigest }, null, 2); d.append(setup);
  for (const x of e.line.excursions) {
    const p = document.createElement('p'), a = document.createElement('a'); a.href = e.replay + '&t=' + Math.max(0, x.start - 1).toFixed(2); a.target = '_blank';
    a.textContent = `Review excursion ${fmt(x.start)}–${fmt(x.end)} s`; p.append(a, document.createTextNode(` · peak offset ${fmt(x.peakOffset)} m · nearest car ${fmt(x.nearestAtStart?.distance)} m · ${x.frontAtStart ? 'car ' + x.frontAtStart.id + ' ahead' : 'no car within 50 m ahead'} · NN correction ${JSON.stringify(x.correctionAtStart)}`)); d.append(p);
  }
  if (!e.line.excursions.length) { const p = document.createElement('p'); p.textContent = 'No illegal-line excursion observed in the saved replay samples. See full-run checks for 120 Hz legality.'; d.append(p); }
}
function render() {
  const needle = $('find').value.toLowerCase(), kind = $('kind').value;
  const list = report.episodes.filter(e => (!kind || e.kind === kind) && (!needle || (e.name + ' ' + e.model).toLowerCase().includes(needle)) && (!$('failed').checked || e.violations.length));
  $('count').textContent = `${list.length} matching · showing first ${Math.min(200, list.length)}`; $('runs').replaceChildren();
  for (const e of list.slice(0, 200)) {
    const tr = document.createElement('tr');
    for (const value of [e.name, `${e.fixture} · ${e.classId} · ${e.seconds}s`, e.violations.join(', ') || 'zero damage / legal', fmt(e.damage * 100) + '%', fmt(e.trackLimitSeconds) + ' s', fmt(e.bestFullLap) + ' s']) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    const td = document.createElement('td'), button = document.createElement('button'); button.textContent = 'Details'; button.onclick = () => inspect(e); td.append(button); tr.append(td); $('runs').append(tr);
  }
  if (list.length) inspect(list[0]); else $('detail').textContent = 'No matching runs.';
}
$('find').oninput = render; $('kind').onchange = render; $('failed').onchange = render; render();
