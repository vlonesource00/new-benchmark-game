// SLIPSTREAM replay viewer server: serves the page and every runs/<run>/replays/<name>.json.
//   node subjects/slipstream/viewer/serve.mjs [port]
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = join(HERE, '..', 'runs');
const port = Number(process.argv[2] || 4183);

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

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(join(HERE, 'index.html')));
    } else if (url.pathname === '/api/replays') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list()));
    } else if (url.pathname === '/api/replay') {
      const run = url.searchParams.get('run'), name = url.searchParams.get('name');
      if (!/^[a-z0-9-]+$/i.test(run) || !/^[a-z0-9._-]+$/i.test(name)) throw new Error('bad name');
      res.writeHead(200, { 'content-type': 'application/json' }).end(readFileSync(join(RUNS, run, 'replays', name + '.json')));
    } else res.writeHead(404).end();
  } catch (e) { res.writeHead(400).end(String(e.message)); }
}).listen(port, () => console.log(`slipstream viewer on http://localhost:${port}`));
