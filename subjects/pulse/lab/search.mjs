const $ = id => document.getElementById(id), name = new URLSearchParams(location.search).get('name');
const format = (n, unit = ' s') => Number.isFinite(n) ? n.toFixed(3) + unit : '—';
if (!name || !/^[a-z0-9-]+$/i.test(name)) throw Error('Select a named search report');
const response = await fetch('/artifacts/counterfactuals/' + name + '/report.json');
if (!response.ok) throw Error('Search report unavailable');
const report = await response.json();
$('title').textContent = name;
$('scope').textContent = report.scope;
const w = report.winner;
$('result').textContent = w ? 'Best admitted trial: ' + w.candidate.label + '. ' +
  (report.improvesBaseline ? 'Selection-cost gain: ' + format(report.gainSeconds) + '. ' :
    report.recoversFailedBaseline ? 'The unchanged policy failed this encounter; this trial passes the admission gate. ' : '') +
  (report.beatsEveryMeasuredTeacher ? 'It beats the four measured reference executions under the stated gate.' :
    'Superiority to the four reference drivers has not been demonstrated.') : 'No sampled alternative passed the admission gate.';
for (const reference of report.references) {
  const p = document.createElement('p'), link = document.createElement('a');
  link.href = reference.replay; link.textContent = reference.expertDriver; p.append(link);
  p.append(' · ' + format(reference.outcome.checkpointSeconds) + ' · ' + reference.outcome.retainedAtEnd +
    ' held · ' + (reference.outcome.cumulativeDamage * 100).toFixed(2) + '% damage · ' +
    (reference.outcome.admissible ? 'admitted' : reference.outcome.failures.join(', ')));
  $('references').append(p);
}
function render() {
  $('trials').replaceChildren();
  const trials = [...report.trials].sort((a, b) => Number(b.outcome.admissible) - Number(a.outcome.admissible)
    || (a.outcome.costSeconds ?? a.searchCost ?? Infinity) - (b.outcome.costSeconds ?? b.searchCost ?? Infinity));
  for (const t of trials) {
    if ($('admitted').checked && !t.outcome.admissible) continue;
    const tr = document.createElement('tr'), first = document.createElement('td'), link = document.createElement('a');
    link.href = t.replay; link.textContent = t.candidate.label + (w?.candidate.label === t.candidate.label ? ' ★' : '');
    first.append(link); tr.append(first);
    const values = [t.outcome.admissible ? 'Admitted' : t.outcome.failures.join(', '), t.outcome.retainedAtEnd,
      format(t.outcome.checkpointSeconds), format(t.outcome.cumulativeDamage * 100, '%'),
      format(t.outcome.maxWearSpent * 100, '%'), format(t.outcome.costSeconds)];
    for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    $('trials').append(tr);
  }
}
$('protocol').textContent = JSON.stringify({ settings: report.settings, model: report.model, branchAt: report.branchAt,
  searchMode: report.searchMode, searchSettings: report.searchSettings, objective: report.objective,
  prefixMismatches: report.trials.filter(t => !t.identicalPrefix).length, winningControls: w?.candidate,
  generations: report.generations, trainingFile: report.trainingFile, versions: report.versions }, null, 2);
$('admitted').onchange = render; render();
const evaluation = new URLSearchParams(location.search).get('evaluation');
if (evaluation) {
  if (!/^[a-z0-9-]+$/i.test(evaluation)) throw Error('Invalid fitted-policy evaluation');
  const response = await fetch('/artifacts/outcome-evaluations/' + evaluation + '/report.json');
  if (!response.ok) throw Error('Fitted-policy evaluation unavailable');
  const fitted = await response.json(), encounter = fitted.cases.find(c => c.source === name);
  if (!encounter || ['simulatorDigest', 'observationDigest', 'schemaDigest'].some(k => fitted.versions[k] !== report.versions[k]))
    throw Error('Fitted-policy evaluation uses a different encounter or physical contract');
  $('learned-section').hidden = false;
  $('learned-scope').textContent = 'NN alone, with no search intervention. ' + fitted.scope;
  const p = document.createElement('p'), link = document.createElement('a'), o = encounter.outcome;
  link.href = encounter.replay; link.textContent = 'Watch the fitted NN'; p.append(link);
  p.append(' · ' + format(o.checkpointSeconds) + ' · ' + o.retainedAtEnd + ' held · ' +
    format(o.cumulativeDamage * 100, '%') + ' damage · ' + (o.admissible ? 'admitted' : o.failures.join(', ')));
  $('learned').append(p);
  const model = document.createElement('p'); model.textContent = 'Checkpoint: ' + fitted.model; $('learned').append(model);
}
