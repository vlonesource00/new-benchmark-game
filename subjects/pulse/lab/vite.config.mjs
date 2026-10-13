import { defineConfig } from '../../../node_modules/vite/dist/node/index.js';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { jobs } from './jobs-api.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(root, '../..');
export default defineConfig({ root, cacheDir: resolve(root, 'artifacts/vite-cache'),
  server: { host: '127.0.0.1', port: 4181, strictPort: true, fs: { allow: [repo] },
    // Generated multi-GB recordings are served on request, never watched for HMR.
    watch: { ignored: ['**/artifacts/**', '**/data/**', '**/results/**', '**/.venv/**'] } },
  plugins: [{ name: 'pulse-laboratory', configureServer(server) {
    server.middlewares.use('/api/episodes', (_req, res) => {
      const directory = resolve(root, 'results');
      // Newest first, so the latest recordings are on top of thousands of old ones.
      const episodes = existsSync(directory) ? readdirSync(directory).filter(n => n.endsWith('.json'))
        .map(name => ({ name, url: '/results/' + name, at: statSync(resolve(directory, name)).mtimeMs })).sort((a, b) => b.at - a.at) : [];
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(episodes));
    });
    // GPU env recordings (gpu-sim/run_env.py --out results/gpu-episodes/<run>), newest run first.
    server.middlewares.use('/api/gpu-episodes', (_req, res) => {
      const directory = resolve(root, 'results/gpu-episodes');
      const runs = existsSync(directory) ? readdirSync(directory).map(name => ({ name, at: statSync(resolve(directory, name)).mtimeMs,
        episodes: readdirSync(resolve(directory, name)).filter(n => /^\d+-.*\.json$/.test(n)).map(n => ({ name: n, url: `/results/gpu-episodes/${name}/${n}` })),
        // run_env.py --neurons: layer layout and intent-head weights for the network view.
        network: existsSync(resolve(directory, name, 'network.json')) ? `/results/gpu-episodes/${name}/network.json` : null }))
        .sort((a, b) => b.at - a.at) : [];
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(runs));
    });
    server.middlewares.use('/api/jobs', (_req, res) => {
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(jobs(root)));
    });
    server.middlewares.use('/ort/', (req, res, next) => {
      const name = req.url?.split('?')[0]?.slice(1);
      if (!name || !/^ort-wasm[-a-z.]+\.(wasm|mjs)$/.test(name)) return next();
      const path = resolve(root, 'node_modules/onnxruntime-web/dist', name);
      if (!existsSync(path)) return next();
      res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); res.end(readFileSync(path));
    });
  } }],
  build: { target: 'esnext', outDir: resolve(root, 'artifacts/lab-dist'), rollupOptions: { input: { lab: resolve(root, 'index.html'), gpu: resolve(root, 'gpu.html'), search: resolve(root, 'search.html'), audit: resolve(root, 'audit.html'), jobs: resolve(root, 'jobs.html'), gpuEpisodes: resolve(root, 'gpu-episodes.html') } } }
});
