// The health check against a pretend site: once healthy, once paused the way Vercel pauses a project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { checkHealth, formatHealth } from '../tools/health.mjs';

function fakeSite(mode) {
  const server = createServer((req, res) => {
    if (mode === 'paused') { res.writeHead(503, { 'content-type': 'text/plain', 'x-vercel-error': 'DEPLOYMENT_PAUSED' }).end('The deployment is currently unavailable'); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': 'https://www.thekartavya.com' }).end(); return; }
    const sec = { 'strict-transport-security': 'max-age=1', 'content-security-policy': "default-src 'self'", 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin' };
    const files = { '/robots.txt': 'Sitemap: x', '/sitemap.xml': '<urlset></urlset>', '/llms.txt': '# Kartavya' };
    if (files[req.url]) { res.writeHead(200, { 'content-type': 'text/plain' }).end(files[req.url]); return; }
    if (['/', '/how-it-works', '/policies', '/login'].includes(req.url)) {
      res.writeHead(200, { 'content-type': 'text/html', ...sec }).end('<title>Elder care at home</title><meta name="description" content="x"><link rel="canonical" href="x">');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html' }).end('not found');
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

test('a healthy site passes every check', async () => {
  const s = await fakeSite('ok');
  try {
    const h = await checkHealth({ base: s.url, api: s.url, demo: s.url, tls: false });
    assert.equal(h.ok, true, formatHealth(h));
    assert.equal(h.warnings, 0, formatHealth(h));
    assert.match(formatHealth(h), /is up\*\* · everything checked is fine/);
  } finally { s.close(); }
});

test('a paused deployment is critical, and the message says what to do', async () => {
  const s = await fakeSite('paused');
  try {
    const h = await checkHealth({ base: s.url, api: s.url, demo: s.url, tls: false });
    assert.equal(h.ok, false);
    const text = formatHealth(h);
    assert.match(text, /has a problem\*\*/);
    assert.match(text, /🔴 Hosting: Vercel says DEPLOYMENT_PAUSED: the whole site is offline\. Resume the project in the Vercel dashboard\./);
    assert.match(text, /🔴 Page \/login: answered 503 DEPLOYMENT_PAUSED/);
  } finally { s.close(); }
});
