// Live job progress for the lab Jobs page. Reads only what the tools already
// write: teacher/evaluation reports, fit progress, RL configs and logs.
// Shards (name-0, name-1, ...) are grouped into one job; ETA = measured rate.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const RECENT = 12 * 3600e3, STALE = 20 * 60e3, FINISHED_SHOWN = 8;
const json = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const dirs = path => existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter(d => d.isDirectory() || d.isSymbolicLink()).map(d => d.name) : [];
const stat = path => { try { return statSync(path); } catch { return null; } };

function part(kind, name, file, done, total, startedAt, finished, extra = {}) {
  const s = stat(file); if (!s) return null;
  // Without a recorded start, a finished job's file birth time is unreliable (data moves to E:).
  const now = Date.now(), updated = s.mtimeMs, start = startedAt ?? (finished ? null : s.birthtimeMs);
  if (now - updated > RECENT) return null;
  const state = finished ? 'complete' : now - updated > STALE ? 'stalled' : 'running';
  return { kind, name, done, total: finished && total == null ? done : total, start, updated, state, ...extra };
}

function group(parts) {
  const groups = new Map();
  for (const p of parts.filter(Boolean)) {
    const key = p.kind + ':' + p.name.replace(/-\d+$/, '');
    const g = groups.get(key) ?? { kind: p.kind, name: p.name.replace(/-\d+$/, ''), shards: [] };
    g.shards.push(p); groups.set(key, g);
  }
  const now = Date.now();
  return [...groups.values()].map(g => {
    const done = g.shards.reduce((n, s) => n + s.done, 0), known = g.shards.every(s => Number.isFinite(s.total));
    const total = known ? g.shards.reduce((n, s) => n + s.total, 0) : null;
    const starts = g.shards.map(s => s.start).filter(Number.isFinite), start = starts.length ? Math.min(...starts) : null, updated = Math.max(...g.shards.map(s => s.updated));
    const state = g.shards.some(s => s.state === 'running') ? 'running' : g.shards.every(s => s.state === 'complete') ? 'complete' : 'stalled';
    // Each shard runs in parallel: the job ends with its slowest shard.
    const etas = g.shards.filter(s => s.state === 'running' && Number.isFinite(s.total) && s.done > 0)
      .map(s => (now - s.start) / s.done * (s.total - s.done));
    const eta = state === 'running' && etas.length ? Math.max(...etas) : state === 'running' && g.shards[0].eta ? g.shards[0].eta : null;
    return { kind: g.kind, name: g.name, done, total, start, updated, state, eta, detail: g.shards.every(s => Number.isFinite(s.succeeded))
        ? `${g.shards.reduce((n, s) => n + s.succeeded, 0)}/${done} succeeded` : g.shards[0].detail ?? null,
      shards: g.shards.length > 1 ? g.shards.map(s => ({ name: s.name, done: s.done, total: s.total, state: s.state })) : null };
  }).sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || b.updated - a.updated)
    .filter((j, k, all) => j.state !== 'complete' || all.filter(o => o.state === 'complete').indexOf(j) < FINISHED_SHOWN);
}

export function jobs(root) {
  const parts = [];
  const teacher = resolve(root, 'artifacts/teacher');
  for (const name of dirs(teacher)) {
    const file = resolve(teacher, name, 'report.json'), r = json(file); if (!r) continue;
    parts.push(part('Teacher labels', name, file, r.cases?.length ?? 0, r.caseCount ?? null, r.startedAt, r.status !== 'running'));
  }
  const suites = resolve(root, 'artifacts/driving-suites');
  for (const name of dirs(suites)) {
    const file = resolve(suites, name, 'report.json'), r = json(file); if (!r) continue;
    parts.push(part('Evaluation', name, file, r.cases?.length ?? 0, r.caseCount ?? null, r.startedAt, r.status !== 'running',
      { succeeded: r.status === 'complete' ? r.succeeded : undefined }));
  }
  const models = resolve(root, 'artifacts/models');
  for (const name of dirs(models)) {
    const file = resolve(models, name, 'progress.json'), p = json(file); if (!p) continue;
    const total = p.contract?.arguments?.epochs ?? null, done = p.history?.length ?? 0;
    const last = p.history?.at(-1);
    parts.push(part('GPU fit', name, file, done, total, Number.isFinite(p.seconds) ? stat(file).mtimeMs - p.seconds * 1e3 : null, !!p.complete,
      { detail: last ? `epoch ${last.epoch} · validation ${last.validationLoss.toFixed(4)} · best epoch ${p.selectedEpoch}` : null }));
  }
  const rl = resolve(root, 'artifacts/rl');
  for (const name of dirs(rl)) {
    const config = json(resolve(rl, name, 'config.json')); if (!config) continue;
    const logFile = resolve(rl, name, 'log.jsonl'), configFile = resolve(rl, name, 'config.json');
    const lines = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    // Development checks run in the background and log their own lines.
    const log = lines.filter(e => e.type !== 'dev'), devs = new Map(lines.filter(e => e.type === 'dev').map(e => [e.iteration, e.dev]));
    for (const e of log) if (devs.has(e.iteration)) e.dev = devs.get(e.iteration);
    const store = config.store ?? resolve('E:/pulse-store/rl', name), perIteration = config.workers * config.perWorker;
    const current = resolve(store, `it-${String(log.length + 1).padStart(3, '0')}`);
    let rolled = 0;
    for (const w of dirs(current).filter(d => d.startsWith('w'))) rolled += readdirSync(resolve(current, w)).length;
    const finished = log.length >= config.iterations, fraction = finished ? 0 : Math.min(.95, rolled / perIteration * .8);
    const pace = log.length ? log.reduce((n, e) => n + e.seconds, 0) / log.length : null;
    const last = log.at(-1), best = json(resolve(rl, name, 'best.json'));
    const file = log.length ? logFile : configFile;
    parts.push(part('RL (PPO)', name, file, log.length + fraction, config.iterations, stat(configFile)?.birthtimeMs, finished, {
      eta: pace ? pace * (config.iterations - log.length - fraction) * 1e3 : null,
      detail: [`iteration ${log.length + (finished ? 0 : 1)}/${config.iterations}`, finished ? null : rolled >= perIteration ? `${rolled} rollouts done · PPO update on GPU` : `${rolled}/${perIteration} rollouts (CPU)`,
        last ? `train success ${(last.success * 100).toFixed(0)}% · return ${last.meanReturn.toFixed(1)} · damage ${(last.damage * 100).toFixed(1)}%` : null,
        best ? `best dev ${best.ok}/${best.total ?? '?'} (it ${best.iteration})` : null].filter(Boolean).join(' · '),
      history: log.map(e => ({ iteration: e.iteration, success: e.success, meanReturn: e.meanReturn, damage: e.damage, dev: e.dev ?? null })) }));
  }
  const grouped = group(parts);
  for (const g of grouped) if (g.kind === 'RL (PPO)') g.history = parts.find(p => p && p.kind === g.kind && p.name === g.name)?.history ?? [];
  return { now: Date.now(), jobs: grouped };
}
