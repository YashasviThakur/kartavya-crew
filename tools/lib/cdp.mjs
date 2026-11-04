// Headless Chrome over the DevTools protocol, with no packages: Node's own WebSocket talks to Chrome.
// One browser, many pages; each page records its console errors, failed requests and bytes downloaded.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
export const chromePath = () => CANDIDATES.find(p => existsSync(p));
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// requests that fail on purpose while a page is being looked at (videos stopped mid-download, prefetches)
const QUIET_FAILURE = /ERR_ABORTED|ERR_BLOCKED_BY_CLIENT|ERR_CACHE_MISS/;

export async function launch({ tmpRoot }) {
  const exe = chromePath();
  if (!exe) throw new Error('Chrome was not found. Install Google Chrome or set CHROME to its path.');
  mkdirSync(tmpRoot, { recursive: true });
  const profile = mkdtempSync(join(tmpRoot, 'chrome-'));
  const proc = spawn(exe, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 300 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) { proc.kill(); throw new Error('Chrome did not start'); }
  let port, path;
  for (let i = 0; i < 50; i++) { [port, path] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/); if (path) break; await sleep(100); }

  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not reach Chrome')); });
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, method } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(`${method}: ${m.error.message}`)); else resolve(m.result);
    } else for (const l of listeners) l(m);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  async function newPage({ width, height, mobile = false, scale = 1, init = '' }) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    const on = fn => { const l = m => { if (m.sessionId === sessionId) fn(m); }; listeners.add(l); return () => listeners.delete(l); };
    const page = { errors: [], failed: [], bytes: 0, requests: 0 };
    on(m => {
      const p = m.params;
      if (m.method === 'Runtime.exceptionThrown') page.errors.push(p.exceptionDetails.exception?.description?.split('\n')[0] || p.exceptionDetails.text);
      else if (m.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'assert')) page.errors.push(p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
      else if (m.method === 'Log.entryAdded' && p.entry.level === 'error' && !/favicon/.test(p.entry.url || '')) page.errors.push(`${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`.slice(0, 300));
      else if (m.method === 'Network.responseReceived' && p.response.status >= 400 && !/favicon/.test(p.response.url)) page.failed.push(`${p.response.status} ${p.response.url}`);
      else if (m.method === 'Network.loadingFailed' && !p.canceled && !QUIET_FAILURE.test(p.errorText)) page.failed.push(`${p.errorText} (${p.type})`);
      else if (m.method === 'Network.loadingFinished') { page.bytes += p.encodedDataLength || 0; page.requests += 1; }
    });
    await s('Page.enable'); await s('Runtime.enable'); await s('Network.enable'); await s('Log.enable');
    await s('Network.setCacheDisabled', { cacheDisabled: true });
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
    if (mobile) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    if (init) await s('Page.addScriptToEvaluateOnNewDocument', { source: init });

    const evaluate = async (expression, { timeoutMs = 20000 } = {}) => {
      const r = await Promise.race([
        s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
        sleep(timeoutMs).then(() => { throw new Error('the page did not answer in time'); }),
      ]);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    Object.assign(page, {
      async goto(url, { settleMs = 1200, timeoutMs = 45000 } = {}) {
        page.errors.length = 0; page.failed.length = 0; page.bytes = 0; page.requests = 0;
        let off;
        const loaded = new Promise(res => { off = on(m => { if (m.method === 'Page.loadEventFired') res(); }); });
        const nav = await s('Page.navigate', { url });
        if (nav.errorText) { off(); throw new Error(`could not open ${url}: ${nav.errorText}`); }
        await Promise.race([loaded, sleep(timeoutMs)]);
        off();
        // fonts and images that arrive just after "load"
        await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => {});
        await sleep(settleMs);
      },
      eval: evaluate,
      async screenshot({ full = false } = {}) {
        let clip;
        if (full) {
          const { cssContentSize: c } = await s('Page.getLayoutMetrics');
          clip = { x: 0, y: 0, width: Math.ceil(c.width), height: Math.min(Math.ceil(c.height), 16000), scale: 1 };
        }
        const { data } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip } : {}) });
        return Buffer.from(data, 'base64');
      },
      close: () => send('Target.closeTarget', { targetId }).catch(() => {}),
    });
    return page;
  }

  async function close() {
    try { await send('Browser.close'); } catch {}
    try { ws.close(); } catch {}
    await sleep(300);
    try { proc.kill(); } catch {}
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  return { newPage, close };
}
