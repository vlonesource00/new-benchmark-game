// SLIPSTREAM replay viewer server: serves the page, every runs/<run>/replays/<name>.json, and /api/status
// (the network the game drives with, the job queue in runs/queue.json with live progress, training curves, completion results).
//   node subjects/slipstream/viewer/serve.mjs [port]
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Deployed network: the weights the game's SLIPSTREAM bridge loads. Parsed once per file change (4 MB).
let netCache = null;
function network() {
  const p = join(SUBJECT, 'policy', 'slipstream.json');
  if (!existsSync(p)) return null;
  const m = statSync(p).mtimeMs;
  if (netCache?.m === m) return netCache.v;
  const e = readJson(p), shapes = {}, blocks = {};
  for (const [k, v] of Object.entries(e.params)) {
    shapes[k] = v.shape; const b = k.split('.')[0];
    blocks[b] = (blocks[b] ?? 0) + v.shape.reduce((a, x) => a * x, 1);
  }
  const v = { ckpt: e.ckpt, iter: e.iter, layout: e.layout, hidden: e.hidden, shapes, blocks, params: Object.values(blocks).reduce((a, x) => a + x, 0), updated: m };
  netCache = { m, v };
  return v;
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
  const budget = head.args?.minutes || 0, last = recs.at(-1) ?? { min: 0 };
  const done = !!job.stopped || existsSync(join(dir, 'final.pt'));  // stopped: ended early on purpose
  const stride = Math.max(1, Math.ceil(recs.length / 300));
  const curve = recs.filter((_, i) => i % stride === 0 || i === recs.length - 1).map((r) => [r.it, r.min, r.rew, r.std?.[0], r.std?.[1], r.kl, r.sps, r.steps]);
  return {
    stdMin: head.args?.std_min || null, stopped: recs.filter((r) => r.stopped).length, updates: recs.length,
    state: done ? 'done' : 'running', progress: done ? 1 : Math.min(1, last.min / (budget || 1)), etaMin: done ? 0 : Math.max(0, budget - last.min),
    minutes: budget, elapsed: last.min, resume: head.args?.resume, config: head.args?.config,
    latest: { it: last.it, steps: last.steps, rew: last.rew, std: last.std, kl: last.kl, sps: last.sps, decide: last.decide },
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

function results() {
  const dir = join(RUNS, 'completion');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.progress.json')).flatMap((f) => {
    const r = tryJson(join(dir, f));
    if (!r) return [];
    return { name: f.slice(0, -5), ckpt: r.ckpt, total: r.complete_total, of: Object.values(r.tracks).reduce((a, t) => a + t.of, 0),
      tracks: Object.fromEntries(Object.entries(r.tracks).map(([k, t]) => [k, [t.complete, t.of, t.gap_median_pct]])), mtime: statSync(join(dir, f)).mtimeMs };
  }).sort((a, b) => a.mtime - b.mtime);
}

function status() {
  const q = existsSync(join(RUNS, 'queue.json')) ? readJson(join(RUNS, 'queue.json')) : { jobs: [] };
  const jobs = q.jobs.map((j) => ({ ...j, ...(j.kind === 'train' ? trainStatus(j) : evalStatus(j)) }));
  const cur = jobs.find((j) => j.state === 'running') ?? jobs.find((j) => j.state === 'queued') ?? null;
  // Every training run in progress (parallel arms are shown side by side); otherwise the latest finished one.
  const running = jobs.filter((j) => j.kind === 'train' && j.state === 'running');
  const last = [...jobs].reverse().find((j) => j.kind === 'train' && j.state !== 'queued');
  const trainings = running.length ? running : last ? [last] : [];
  return {
    now: Date.now(), label: q.label, network: network(),
    jobs: jobs.map(({ curve, result, ...j }) => ({ ...j, total: result?.complete_total })),
    current: cur && { title: cur.title, kind: cur.kind, state: cur.state, progress: cur.progress, etaMin: cur.etaMin, detail: cur.detail },
    overall: jobs.length ? jobs.reduce((a, j) => a + j.progress, 0) / jobs.length : 0,
    trainings, results: results()
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
