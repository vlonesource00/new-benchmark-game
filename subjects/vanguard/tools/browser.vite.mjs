import { fileURLToPath } from 'node:url';
export default {
  root: fileURLToPath(new URL('../../../', import.meta.url)), publicDir: false,
  server: { host: '127.0.0.1', port: 4192, strictPort: true, hmr: false, watch: { ignored: ['**/*'] } }
};
