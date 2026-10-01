import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(fileURLToPath(new URL('../dist/harbor-ring-sandbox/', import.meta.url)));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/startup-status' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 3000) { res.writeHead(413); return res.end(); } }
      const data = JSON.parse(body);
      console.log(JSON.stringify({ startup: String(data.message).slice(0, 800), failed: !!data.failed, agent: String(data.agent).slice(0, 250) }));
      res.writeHead(204); return res.end();
    }
    let name = decodeURIComponent(url.pathname);
    if (name === '/') name = '/index.html';
    const file = path.resolve(root, '.' + name);
    if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', name.endsWith('.html') ? 'no-store' : 'public, max-age=3600');
    const content = await readFile(file);
    if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '') && /\.(js|css|html|json)$/.test(file)) {
      res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Vary', 'Accept-Encoding');
      res.end(gzipSync(content));
    } else res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(4186, '127.0.0.1', () => console.log('Phone spectator: http://127.0.0.1:4186/mobile.html'));
