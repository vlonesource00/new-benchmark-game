import { defineConfig } from '../../../node_modules/vite/dist/node/index.js';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(root, '../..');
export default defineConfig({ root, cacheDir: resolve(root, 'artifacts/vite-cache'),
  server: { host: '127.0.0.1', port: 4181, strictPort: true, fs: { allow: [repo] } },
  plugins: [{ name: 'pulse-laboratory', configureServer(server) {
    server.middlewares.use('/api/episodes', (_req, res) => {
      const directory = resolve(root, 'results');
      const episodes = existsSync(directory) ? readdirSync(directory).filter(n => n.endsWith('.json')).map(name => ({ name, url: '/results/' + name })) : [];
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(episodes));
    });
    server.middlewares.use('/ort/', (req, res, next) => {
      const name = req.url?.split('?')[0]?.slice(1);
      if (!name || !/^ort-wasm[-a-z.]+\.(wasm|mjs)$/.test(name)) return next();
      const path = resolve(root, 'node_modules/onnxruntime-web/dist', name);
      if (!existsSync(path)) return next();
      res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); res.end(readFileSync(path));
    });
  } }],
  build: { target: 'esnext', outDir: resolve(root, 'artifacts/lab-dist'), rollupOptions: { input: { lab: resolve(root, 'index.html'), gpu: resolve(root, 'gpu.html') } } }
});
