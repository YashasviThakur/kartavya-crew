#!/usr/bin/env node
// Is thekartavya.com up and in good shape? Pages answer, nothing is paused, security headers and search
// tags are there, the certificate has time left, the AWS API answers, the demo site is up.
//   node tools/health.mjs            Markdown summary (exit 1 when something critical is wrong)
//   node tools/health.mjs --json
import { parseArgs } from 'node:util';
import { connect } from 'node:tls';
import { LIVE, API, DEMO } from './config.mjs';
import { isMain } from './lib/cli.mjs';

const PAGES = ['/', '/how-it-works', '/policies', '/login'];
const FILES = [['/robots.txt', /sitemap:/i], ['/sitemap.xml', /<urlset/], ['/llms.txt', /kartavya/i]];
const HEADERS = ['strict-transport-security', 'content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy'];
const SLOW_MS = 3000;

async function get(url, { method = 'GET', headers = {}, timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method, headers: { 'user-agent': 'kartavya-crew-health/1', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const body = method === 'GET' ? await r.text() : '';
    return { status: r.status, headers: r.headers, body, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, error: e.cause?.code || e.name || e.message, headers: new Headers(), body: '', ms: Date.now() - t0 };
  }
}

export function certDaysLeft(host, { port = 443, timeoutMs = 10000 } = {}) {
  return new Promise(resolve => {
    const s = connect({ host, port, servername: host, timeout: timeoutMs }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c?.valid_to ? Math.floor((Date.parse(c.valid_to) - Date.now()) / 86400000) : null);
    });
    s.on('error', () => resolve(null));
    s.on('timeout', () => { s.destroy(); resolve(null); });
  });
}

const why = r => (r.status === 0 ? `no answer (${r.error})` : `answered ${r.status}${r.headers.get('x-vercel-error') ? ` ${r.headers.get('x-vercel-error')}` : ''}`);

export async function checkHealth({ base = LIVE, api = API, demo = DEMO, tls = true } = {}) {
  const checks = [];
  const add = (name, ok, severity, detail) => checks.push({ name, ok, severity, detail });
  // the pages people open
  const home = await get(`${base}/`);
  const paused = home.headers.get('x-vercel-error');
  if (paused) add('Hosting', false, 'critical', `Vercel says ${paused}: the whole site is offline. Resume the project in the Vercel dashboard.`);
  for (const p of PAGES) {
    const r = p === '/' ? home : await get(base + p);
    const ok = r.status === 200 && /text\/html/.test(r.headers.get('content-type') || '');
    add(`Page ${p}`, ok, 'critical', ok ? `200 in ${r.ms} ms` : why(r));
    if (ok && r.ms > SLOW_MS) add(`Speed ${p}`, false, 'warn', `took ${(r.ms / 1000).toFixed(1)} s to answer`);
  }
  const missing = await get(`${base}/kv-crew-health-check-missing-page`);
  add('Missing pages show the 404 page', missing.status === 404, 'warn', missing.status === 404 ? '404 as it should' : why(missing));
  // files search engines and AI assistants read
  for (const [p, re] of FILES) {
    const r = await get(base + p);
    add(`File ${p}`, r.status === 200 && re.test(r.body), 'warn', r.status === 200 ? (re.test(r.body) ? 'present' : 'present but looks wrong') : why(r));
  }
  if (home.status === 200) {
    const lost = HEADERS.filter(h => !home.headers.get(h));
    add('Security headers', !lost.length, 'warn', lost.length ? `missing: ${lost.join(', ')}` : 'all present');
    const tag = re => re.test(home.body);
    const tags = [['title', /<title>[^<]{5,}<\/title>/i], ['description', /<meta[^>]+name="description"/i], ['canonical', /<link[^>]+rel="canonical"/i]].filter(([, re]) => !tag(re)).map(([n]) => n);
    add('Search tags on the homepage', !tags.length, 'warn', tags.length ? `missing: ${tags.join(', ')}` : 'title, description and canonical present');
  }
  if (tls) {
    const days = await certDaysLeft(new URL(base).hostname);
    add('Certificate', days !== null && days >= 14, days !== null && days < 3 ? 'critical' : 'warn', days === null ? 'could not read it' : `${days} days left`);
  }
  // the AWS API answers its CORS preflight without doing any work, so this touches no data
  const pre = await get(`${api}/me`, { method: 'OPTIONS', headers: { origin: 'https://www.thekartavya.com', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
  add('Sign-in API', pre.status >= 200 && pre.status < 300, 'critical', pre.status >= 200 && pre.status < 300 ? `answers in ${pre.ms} ms` : why(pre));
  const d = await get(`${demo}/`);
  add('Demo site', d.status === 200, 'warn', d.status === 200 ? 'up' : why(d));

  const critical = checks.filter(c => !c.ok && c.severity === 'critical');
  const warnings = checks.filter(c => !c.ok && c.severity === 'warn');
  return { at: new Date().toISOString(), base, ok: !critical.length, critical: critical.length, warnings: warnings.length, checks };
}

export function formatHealth(h) {
  const head = h.ok
    ? `**${h.base.replace(/^https?:\/\//, '')} is up**${h.warnings ? ` · ${h.warnings} thing${h.warnings > 1 ? 's' : ''} to look at` : ' · everything checked is fine'}`
    : `**${h.base.replace(/^https?:\/\//, '')} has a problem** · ${h.critical} critical${h.warnings ? `, ${h.warnings} more to look at` : ''}`;
  const bad = h.checks.filter(c => !c.ok).map(c => `- ${c.severity === 'critical' ? '🔴' : '🟡'} ${c.name}: ${c.detail}`);
  const good = h.checks.filter(c => c.ok).length;
  return [head, ...bad, `${good} of ${h.checks.length} checks fine · ${new Date(h.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST`].join('\n');
}

if (isMain(import.meta.url)) {
  const { values: v } = parseArgs({ options: { json: { type: 'boolean' }, base: { type: 'string' } } });
  const h = await checkHealth({ base: v.base ?? LIVE });
  console.log(v.json ? JSON.stringify(h, null, 2) : formatHealth(h));
  process.exit(h.ok ? 0 : 1);
}
