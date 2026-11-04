// Serves a copy of the Kartavya site the way Vercel does: /login is login.html, a folder serves its
// index.html, anything missing gets 404.html with a real 404. Only on 127.0.0.1, only while a check runs.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf',
};
const isFile = async p => { try { return (await stat(p)).isFile(); } catch { return false; } };

export function serveSite(root, port = 0) {
  const top = normalize(root);
  const server = createServer(async (req, res) => {
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    let file = normalize(join(top, path));
    if (file !== top && !file.startsWith(top + sep)) { res.writeHead(403).end(); return; }
    // never serve the repository's private parts
    if (path.split('/').some(s => s.startsWith('.') && s !== '.well-known') || /^\/(backend|node_modules|test|e2e|scripts)(\/|$)/.test(path)) file = '';
    if (file && !(await isFile(file))) {
      file = (await isFile(`${file}.html`)) ? `${file}.html` : (await isFile(join(file, 'index.html'))) ? join(file, 'index.html') : '';
    }
    const status = file ? 200 : 404;
    if (!file) file = join(top, '404.html');
    try {
      const body = await readFile(file);
      const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
      // byte ranges, so the hero film plays instead of stalling
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range && status === 200 && /^(video|audio)\//.test(type)) {
        const start = range[1] ? Number(range[1]) : body.length - Number(range[2]);
        const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
        res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
        return;
      }
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(status === 404 ? 404 : 500).end(); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) }));
  });
}
