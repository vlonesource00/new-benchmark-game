// PPO loop: parallel physical rollouts (CPU) -> PPO update (GPU) -> next policy.
// On-policy rollouts are deleted after their update; the iteration log keeps
// their summaries. Every --eval-every iterations the policy drives the plan's
// development split in the background (training continues); the best
// development success is the selected model.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, appendFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOME } from './versions.mjs';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const name = arg('name'), planPath = arg('plan'), workers = +arg('workers', 16), perWorker = +arg('episodes', 5);
const iterations = +arg('iterations', 40), evalEvery = +arg('eval-every', 5), sigma = arg('sigma', '.15'), bc = arg('bc');
const store = resolve(arg('store', 'C:/pulse-store/rl'), name), root = resolve(HOME, 'artifacts/rl', name);
if (!name || !planPath || existsSync(root)) throw Error('--name (new) and --plan required');
mkdirSync(root, { recursive: true }); mkdirSync(store, { recursive: true });
const plan = JSON.parse(readFileSync(resolve(HOME, planPath), 'utf8')), train = plan.cases.filter(c => c.split === 'train').map(c => c.id);
const log = entry => { appendFileSync(resolve(root, 'log.jsonl'), JSON.stringify(entry) + '\n'); console.log(JSON.stringify(entry)); };
const run = (cmd, argv, opts = {}) => new Promise((ok, fail) => {
  const p = spawn(cmd, argv, { cwd: opts.cwd ?? HOME, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
  p.on('close', code => code ? fail(Error(`${cmd} ${argv[0]} exit ${code}: ${err.slice(-800)}`)) : ok(out));
});
const node = ['--import', '../../scripts/json-loader.mjs'];
const python = resolve(HOME, '.venv/Scripts/python.exe');
let s = 0x9e3779b9 ^ +arg('seed', 3);
const draw = () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 2 ** 32; };
async function evaluate(model, tag) {
  const shards = 6;
  await Promise.all(Array.from({ length: shards }, (_, k) => run('node', [...node, 'tools/plan-evaluate.mjs', '--name', `${name}-${tag}-dev-${k}`,
    '--model', model, '--plan', planPath, '--shard', String(k), '--shards', String(shards), '--roadBounds', 'line-kerb-v1', '--edgeRamp', '30',
    '--frontalGuard', 'live-body-speed-v1', '--routeOrigin', 'rolling-v1', '--feedback', 'course-v1', '--joinState', 'reference-v1', '--traces', 'off'])));
  let ok = 0, total = 0;
  for (let k = 0; k < shards; k++) {
    const r = JSON.parse(readFileSync(resolve(HOME, 'artifacts/driving-suites', `${name}-${tag}-dev-${k}`, 'report.json'), 'utf8'));
    ok += r.succeeded; total += r.cases.length;
  }
  return { ok, total };
}
let model = arg('model'), best = { ok: -1 };
if (arg('baseline')) best = { ok: +arg('baseline'), model, iteration: 0 };
writeFileSync(resolve(root, 'config.json'), JSON.stringify({ name, plan: planPath, start: model, workers, perWorker, iterations, evalEvery, sigma, bc, store }, null, 2));
const pending = [];
for (let it = 1; it <= iterations; it++) {
  const started = Date.now(), dir = resolve(store, `it-${String(it).padStart(3, '0')}`);
  const picks = Array.from({ length: workers * perWorker }, () => train[Math.floor(draw() * train.length)]);
  // Distinct files per worker: a scene drawn twice goes to different workers' folders.
  await Promise.all(Array.from({ length: workers }, (_, w) => run('node', [...node, 'tools/rl-rollout.mjs', '--out', resolve(dir, 'w' + w),
    '--model', model, '--plan', planPath, '--sigma', sigma, '--seed', String(it * 1000 + w),
    '--cases', [...new Set(picks.slice(w * perWorker, (w + 1) * perWorker))].join(',')])));
  const flat = resolve(dir, 'all'); mkdirSync(flat);
  for (const w of readdirSync(dir).filter(d => d.startsWith('w')))
    for (const f of readdirSync(resolve(dir, w))) writeFileSync(resolve(flat, `${w}-${f}`), readFileSync(resolve(dir, w, f)));
  const next = `artifacts/models/${name}-it${String(it).padStart(3, '0')}`;
  const out = await run(python, ['ppo_plan.py', '--parent', resolve(HOME, model), '--rollouts', flat, '--out', resolve(HOME, next),
    ...(bc ? ['--bc', resolve(HOME, bc), '--bc-weight', arg('bc-weight', '.5'), '--cache', arg('cache', 'C:/pulse-store/cache')] : []), '--seed', String(it)], { cwd: resolve(HOME, 'training') });
  const report = JSON.parse(out.trim().split('\n').filter(l => l.startsWith('{')).at(-1));
  rmSync(dir, { recursive: true, force: true });
  model = next;
  const entry = { iteration: it, model, seconds: Math.round((Date.now() - started) / 1000), ...report };
  log(entry);
  if (it % evalEvery === 0 || it === iterations) {
    const evaluated = model, at = it;
    pending.push(evaluate(evaluated, `it${at}`).then(dev => {
      if (dev.ok > best.ok) best = { ...dev, model: evaluated, iteration: at };
      writeFileSync(resolve(root, 'best.json'), JSON.stringify(best, null, 2));
      log({ type: 'dev', iteration: at, model: evaluated, dev, best });
    }, error => log({ type: 'dev', iteration: at, model: evaluated, error: error.message.slice(0, 400) })));  // a failed check never stops training
  }
}
await Promise.all(pending);
