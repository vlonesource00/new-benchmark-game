// SLIPSTREAM replay viewer server: serves the page, every runs/<run>/replays/<name>.json, and /api/status
// (the network the game drives with, the job queue in runs/queue.json with live progress, training curves, completion results).
//   node subjects/slipstream/viewer/serve.mjs [port]
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchActivity } from './activity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBJECT = join(HERE, '..');
const RUNS = join(SUBJECT, 'runs');
const port = Number(process.argv[2] || 4183);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
// A test or trainer may be mid-write: a half-written JSON file reads as missing until the next poll.
const tryJson = (p) => { try { return readJson(p); } catch { return null; } };
const lines = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean);

const list = () => {
  const out = [];
  if (!existsSync(RUNS)) return out;
  for (const run of readdirSync(RUNS)) {
    const dir = join(RUNS, run, 'replays');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.json')) out.push({ run, name: f.slice(0, -5), mtime: statSync(join(dir, f)).mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
};

// Networks for the Network tab: the two the game races (the bridge picks by track: game/bridges/slipstream-bridge.js
// TRACK_WEIGHTS) and the combat network under test (the winners board's combat pick; not in the game). Each export is
// parsed once per file change (4-8 MB): parameter shapes and counts per block, for a plain actor or both MoE experts.
const NETS = [
  { key: 'main', file: 'policy/slipstream.json', role: 'Short tracks and every track without its own network' },
  { key: 'nurb', file: 'policy/slipstream-nurburgring.json', role: 'Nürburgring' },
  { key: 'combat', file: 'runs/export/pas1c.json', role: 'Combat network in test (not in the game yet)' },
];
const netCache = {};
function actorInfo(params) {
  const shapes = {}, blocks = {};
  for (const [k, v] of Object.entries(params)) { shapes[k] = v.shape; const b = k.split('.')[0]; blocks[b] = (blocks[b] ?? 0) + v.shape.reduce((a, x) => a * x, 1); }
  return { shapes, blocks, params: Object.values(blocks).reduce((a, x) => a + x, 0) };
}
function networks() {
  const out = {};
  for (const n of NETS) {
    const p = join(SUBJECT, n.file);
    if (!existsSync(p)) continue;
    const m = statSync(p).mtimeMs;
    if (netCache[n.key]?.m !== m) {
      const e = readJson(p), v = { role: n.role, file: n.file, ckpt: e.ckpt, iter: e.iter, layout: e.layout, hidden: e.hidden, updated: m };
      if (e.moe) {
        const gate = actorInfo(e.gate);
        Object.assign(v, { moe: true, residual: Boolean(e.residual), wired: Boolean(e.cmb.wired), base: actorInfo(e.base.params), cmb: actorInfo(e.cmb.params),
          gate: { shapes: gate.shapes, params: gate.params }, expertHidden: e.base.hidden });
        v.params = v.base.params + v.cmb.params + gate.params;
      } else Object.assign(v, actorInfo(e.params));
      netCache[n.key] = { m, v };
    }
    out[n.key] = netCache[n.key].v;
  }
  return out;
}

// Two processes appending to one log (a duplicate launch) interleave their records. Every writer logs each iteration,
// so split the records into chains of consecutive iterations with a steady sample stride and keep the chain that ends
// at the newest record (the writer still alive).
function oneWriter(recs) {
  const chains = [];
  for (const r of recs) {
    let best = null, bestErr = Infinity;
    for (const c of chains) {
      const last = c.at(-1);
      if (last.it !== r.it - 1) continue;
      const stride = c.length > 1 ? last.steps - c.at(-2).steps : r.steps - last.steps, err = Math.abs(r.steps - last.steps - stride);
      if (err < bestErr) { best = c; bestErr = err; }
    }
    best ? best.push(r) : chains.push([r]);
  }
  return chains.find((c) => c.at(-1) === recs.at(-1)) ?? recs;
}

function trainStatus(job) {
  const dir = join(RUNS, job.run), log = join(dir, 'log.jsonl');
  if (!existsSync(log)) return { state: 'queued', progress: 0 };
  const ls = lines(log), head = JSON.parse(ls[0]), recs = oneWriter(ls.slice(1).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).filter((r) => r.it != null));
  const last = recs.at(-1) ?? { min: 0 }, target = head.args?.iters, first = recs[0];
  // A time budget, or an iteration target (resumed runs train to an absolute iteration): the time it will take is
  // projected from the iterations done so far.
  const frac = !head.args?.minutes && target && target < 100000 && first && last.it != null ? (last.it - first.it + 1) / Math.max(1, target - first.it + 1) : null;
  const budget = head.args?.minutes || (frac ? +(last.min / Math.max(frac, 1e-3)).toFixed(1) : 0);
  // done: final.pt written. stopped: ended early, marked in the queue or its log quiet for 3 min with no final
  // checkpoint (the process is gone). Only 'running' runs are live.
  const quiet = Date.now() - statSync(log).mtimeMs > 180000;
  const state = existsSync(join(dir, 'final.pt')) ? 'done' : job.stopped || quiet ? 'stopped' : 'running', done = state !== 'running';
  const stride = Math.max(1, Math.ceil(recs.length / 300));
  const curve = recs.filter((_, i) => i % stride === 0 || i === recs.length - 1).map((r) => [r.it, r.min, r.rew, r.std?.[0], r.std?.[1], r.kl, r.sps, r.steps, r.gate_tr, r.gate_solo]);
  return {
    stdMin: head.args?.std_min || null, stopped: recs.filter((r) => r.stopped).length, updates: recs.length,
    state, progress: done ? 1 : Math.min(1, last.min / (budget || 1)), etaMin: done ? 0 : Math.max(0, budget - last.min),
    minutes: budget, elapsed: last.min, resume: head.args?.resume, config: head.args?.config, moe: Boolean(head.args?.moe_base) || last.gate_tr != null,
    latest: { it: last.it, steps: last.steps, rew: last.rew, std: last.std, kl: last.kl, sps: last.sps, decide: last.decide, gate_tr: last.gate_tr, gate_solo: last.gate_solo },
    tracks: head.config?.tracks, latency: head.config?.world?.latency, curve, stale: !done && Date.now() - statSync(log).mtimeMs > 120000
  };
}

function evalStatus(job) {
  const dir = join(RUNS, 'completion'), res = join(dir, job.name + '.json'), prog = join(dir, job.name + '.progress.json');
  const r = existsSync(res) && tryJson(res);
  if (r) { delete r.attempt_log; return { state: 'done', progress: 1, result: r }; }
  const p = existsSync(prog) && tryJson(prog);
  if (p) return { state: 'running', progress: p.done / p.total, detail: p };
  return { state: 'queued', progress: 0 };
}

// Completion results, each file parsed once per change (hundreds of files, polled every 5 s).
const resCache = new Map();
function results() {
  const dir = join(RUNS, 'completion');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.progress.json')).flatMap((f) => {
    const m = statSync(join(dir, f)).mtimeMs, hit = resCache.get(f);
    if (hit?.m === m) return [hit.v];
    const r = tryJson(join(dir, f));
    if (!r) return [];
    const v = { name: f.slice(0, -5), ckpt: r.ckpt, seed: r.seed, laps: r.laps ?? 1, ai: r.ai || '', total: r.complete_total, of: Object.values(r.tracks).reduce((a, t) => a + t.of, 0),
      tracks: Object.fromEntries(Object.entries(r.tracks).map(([k, t]) => [k, [t.complete, t.of, t.gap_median_pct]])), mtime: m };
    resCache.set(f, { m, v });
    return [v];
  }).sort((a, b) => a.mtime - b.mtime);
}

// Reliability: completion results grouped per checkpoint (run + snapshot + test variant), seeds side by side. Result
// names are <run>-snap[-]<min>[-ema][-<variant>...][-s<seed>] or <run>-final[...]; variants such as -2lap-rng2 or
// -noise name the test. Any other name is its own group.
function reliability(res) {
  const groups = new Map();
  for (const r of res) {
    const m = /^(.*?)-(snap-?\d+|final)(-ema)?((?:-[a-z0-9]+)*?)(?:-s(\d+))?$/.exec(r.name);
    const run = m ? m[1] : r.name, snap = m ? (m[2] === 'final' ? 'final' : +m[2].replace(/\D/g, '')) : null, variant = m?.[4]?.slice(1) ?? '';
    const key = [run, snap, m?.[3] ?? '', variant, r.laps, r.ai, Object.keys(r.tracks).join(',')].join('|');
    const g = groups.get(key) ?? { run, snap, ema: Boolean(m?.[3]), variant, laps: r.laps, ai: r.ai, seeds: {}, tracks: {}, mtime: 0 };
    g.seeds[r.seed ?? m?.[5] ?? '?'] = [r.total, r.of];
    for (const [t, v] of Object.entries(r.tracks)) { const a = (g.tracks[t] ??= [0, 0]); a[0] += v[0]; a[1] += v[1]; }
    g.mtime = Math.max(g.mtime, r.mtime); groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, total: Object.values(g.seeds).reduce((a, s) => a + s[0], 0), of: Object.values(g.seeds).reduce((a, s) => a + s[1], 0) }))
    .sort((a, b) => b.mtime - a.mtime);
}

// Benchmarks recorded by viewer/bench-add.mjs (runs/benchmarks.jsonl), oldest first.
function benchmarks() {
  const p = join(RUNS, 'benchmarks.jsonl');
  return existsSync(p) ? lines(p).flatMap((l) => { try { const { key, ...r } = JSON.parse(l); return [r]; } catch { return []; } }) : [];
}

// Everything running now (activity.mjs process scan), with progress from each job's own files: training logs,
// lap-test progress files, finished race files. The queue titles name the trainings it knows.
const ACT = watchActivity();
function activity(jobsQ, label) {
  const title = (run) => jobsQ.find((j) => j.kind === 'train' && j.run === run)?.title;
  const items = ACT.jobs.map((j) => {
    const a = { kind: j.kind, start: j.start, elapsedMin: (Date.now() - j.start) / 60000 };
    if (j.kind === 'train') {
      const log = join(RUNS, j.name ?? '', 'log.jsonl');
      Object.assign(a, { name: j.name, title: title(j.name) });
      if (j.name && existsSync(log)) {
        const ls = lines(log), head = tryJson0(ls[0]), first = tryJson0(ls.slice(1, 4).find((l) => l.startsWith('{"it"'))), last = tryJson0(ls.at(-1));
        const iters = head?.args?.iters, minutes = head?.args?.minutes;
        if (last?.it != null) {
          a.detail = `iteration ${last.it}${iters && iters < 100000 ? ` of ${iters}` : ''} · ${Math.round(last.sps ?? 0)} samples/s`;
          a.progress = minutes ? last.min / minutes : iters && iters < 100000 && first?.it != null ? (last.it - first.it + 1) / Math.max(1, iters - first.it + 1) : null;
          if (a.progress) a.etaMin = minutes ? Math.max(0, minutes - last.min) : last.min * (1 - a.progress) / a.progress;
        }
      }
    } else if (j.kind === 'lap') {
      const p = tryJson(join(RUNS, 'completion', `${j.name}.progress.json`));
      Object.assign(a, { name: j.name, detail: `${j.laps}-lap clean-lap test${j.seed ? ` · seed ${j.seed}` : ''}${j.tracks ? ` · ${j.tracks.split(',').length} tracks` : ''}${p ? ` · ${p.done}/${p.total} attempts, ${p.complete} clean` : ''}`, progress: p ? p.done / p.total : null });
    } else if (j.kind === 'bench') {
      const dir = join(RUNS, 'racebench', j.label ?? ''), total = j.tracks.length * j.seeds.length;
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(j.mode + '-') && !f.includes('summary')) : [], done = files.length;
      // The scan is up to 10 s old: a race whose result file has landed is no longer on track.
      const racing = (j.racing ?? []).filter((r) => !files.some((f) => f.startsWith(`${j.mode}-${r.replace(' s', '-s')}`)));
      Object.assign(a, { name: j.label, detail: `${j.mode} races${j.field ? ` · ${j.field} field` : ''}${j.startType ? ` · ${j.startType} start` : ''} · ${Math.min(done, total)}/${total} finished${racing.length ? ` · on track: ${racing.join(', ')}` : ''}`, progress: total ? Math.min(1, done / total) : null });
    } else if (j.kind === 'drill' || j.kind === 'follow') {
      Object.assign(a, { name: j.name, detail: `${j.kind === 'drill' ? 'passing drill, 360 scenes' : 'following test, 120 scenes'}${j.seed ? ` · seed ${j.seed}` : ''}` });
    } else Object.assign(a, { name: j.name });
    return a;
  });
  // The newest pipeline is the one the queue label describes.
  const pipe = items.filter((a) => a.kind === 'pipeline').at(-1);
  if (pipe && label) pipe.detail = label;
  return { at: ACT.at, ok: ACT.ok, items };
}
const tryJson0 = (l) => { try { return JSON.parse(l); } catch { return null; } };

function status() {
  const q = existsSync(join(RUNS, 'queue.json')) ? readJson(join(RUNS, 'queue.json')) : { jobs: [] };
  const jobs = q.jobs.map((j) => ({ ...j, ...(j.kind === 'train' ? trainStatus(j) : evalStatus(j)) }));
  // A test still 'queued' while a later job has finished was dropped from its pipeline: skipped, not pending.
  let laterDone = false;
  for (let i = jobs.length - 1; i >= 0; i--) { if (jobs[i].state === 'queued' && laterDone) jobs[i].state = 'skipped'; if (['done', 'stopped'].includes(jobs[i].state)) laterDone = true; }
  const cur = jobs.find((j) => j.state === 'running') ?? jobs.find((j) => j.state === 'queued') ?? null;
  // Live: every training run in progress (parallel arms side by side); otherwise the latest finished one.
  const running = jobs.filter((j) => j.kind === 'train' && j.state === 'running');
  const last = [...jobs].reverse().find((j) => j.kind === 'train' && j.state !== 'queued');
  const trainings = running.length ? running : last ? [last] : [];
  const rel = reliability(results()), bench = benchmarks();
  // Experiments: one row per training run, newest first, with its tests attached.
  const experiments = jobs.filter((j) => j.kind === 'train').reverse().map((j) => ({
    run: j.run, title: j.title, state: j.state, minutes: j.minutes, elapsed: j.elapsed, resume: j.resume, config: j.config, moe: j.moe,
    rew: j.latest?.rew, samples: j.latest?.steps, reliability: rel.filter((g) => g.run === j.run), bench: bench.filter((b) => b.run === j.run),
    tests: jobs.filter((e) => e.kind === 'eval' && e.name.startsWith(j.run + '-')).map((e) => ({ name: e.name, state: e.state }))
  }));
  const strip = ({ curve, result, ...j }) => j;
  return {
    now: Date.now(), label: q.label, networks: networks(),
    active: jobs.filter((j) => j.state === 'running' || j.state === 'queued').map(strip),
    counts: Object.fromEntries(['done', 'stopped', 'skipped', 'running', 'queued'].map((k) => [k, jobs.filter((j) => j.state === k).length])),
    current: cur && { title: cur.title, kind: cur.kind, state: cur.state, progress: cur.progress, etaMin: cur.etaMin, detail: cur.detail },
    trainings, live: running.length > 0, experiments, reliability: rel, benchmarks: bench, activity: activity(jobs, q.label)
  };
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(join(HERE, 'index.html')));
    } else if (url.pathname === '/status.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }).end(readFileSync(join(HERE, 'status.js')));
    } else if (url.pathname === '/api/status') {
      const body = JSON.stringify(status());  // build first: a throw here must not follow a sent header
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body);
    } else if (url.pathname === '/api/replays') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list()));
    } else if (url.pathname === '/api/replay') {
      const run = url.searchParams.get('run'), name = url.searchParams.get('name');
      if (!/^[a-z0-9-]+$/i.test(run) || !/^[a-z0-9._-]+$/i.test(name)) throw new Error('bad name');
      res.writeHead(200, { 'content-type': 'application/json' }).end(readFileSync(join(RUNS, run, 'replays', name + '.json')));
    } else res.writeHead(404).end();
  } catch (e) { if (!res.headersSent) res.writeHead(400).end(String(e.message)); else res.end(); }
}).listen(port, () => console.log(`slipstream viewer on http://localhost:${port}`));
