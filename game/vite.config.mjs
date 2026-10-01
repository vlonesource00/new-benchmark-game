import path from 'node:path';
import { fileURLToPath } from 'node:url';

const gameRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(gameRoot, '..');
const three = path.join(workspaceRoot, 'node_modules', 'three');

export default {
  root: gameRoot,
  publicDir: path.join(workspaceRoot, 'host', 'astra', 'public'),
  server: { host: '127.0.0.1', port: 4175, strictPort: true, fs: { allow: [workspaceRoot] } },
  preview: { host: '127.0.0.1', port: 4175, strictPort: true },
  resolve: {
    alias: [
      { find: /^three$/, replacement: path.join(three, 'build', 'three.module.js') },
      { find: /^three\/addons\/(.*)$/, replacement: `${path.join(three, 'examples', 'jsm')}/$1` }
    ],
    dedupe: ['three']
  },
  worker: { format: 'es' },
  build: { outDir: path.join(workspaceRoot, 'dist', 'phantom-endurance'), emptyOutDir: true, sourcemap: false }
};
