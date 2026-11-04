#!/usr/bin/env node
// kv-checker's engine: checks a ticket's branch against main before any person decides to release it.
//   node tools/check.mjs --ticket KV-001            (branch, page and focus come from the ticket)
//   node tools/check.mjs --branch crew/x --pages /,/how-it-works --focus "#plans" --sizes phone,desktop
// Flags: --e2e off  skip the browser journeys (they take a few minutes)   --unit off  skip the unit tests
// Prints the chat summary, then the files to attach. Exit code: 0 pass, 2 fail, 1 the check itself broke.
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STATE, REPO, CHECKER, BASE, TMP, SIZES, FORBIDDEN } from './config.mjs';
import { get, update } from './lib/store.mjs';
import { run, git, gitOut, isMain } from './lib/cli.mjs';
import { launch, sleep } from './lib/cdp.mjs';
import { serveSite } from './lib/serve.mjs';
import * as pc from './lib/pagecheck.mjs';

// The site remembers these between visits. Both sides get the same, so neither shows the cookie notice
// or the first-visit loader over what is being compared.
export const VISIT_INIT = "try { localStorage.setItem('kv-consent', 'essential'); sessionStorage.setItem('kv-pl', '1'); } catch (e) {}";
export const HINDI_INIT = `${VISIT_INIT} try { localStorage.setItem('kv-lang', 'hi'); } catch (e) {}`;

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'home';

// put a worktree at exactly this commit, with nothing left over from the last check
async function placeAt(dir, sha) {
  if (!existsSync(join(dir, '.git'))) throw new Error(`${dir} is missing. Run: node tools/setup.mjs`);
  await gitOut(dir, 'checkout', '--quiet', '--force', '--detach', sha);
  await gitOut(dir, 'clean', '-fdq');
}

async function filesCheck(base, sha) {
  const names = await gitOut(REPO, 'diff', '--name-status', `${base}..${sha}`);
  const files = names ? names.split('\n').map(l => { const [status, ...p] = l.split('\t'); return { status, path: p.at(-1) }; }) : [];
  const raw = await gitOut(REPO, 'log', '--format=%H%x1f%s%x1f%b%x1e', `${base}..${sha}`);
  const commits = raw.split('\x1e').map(s => s.trim()).filter(Boolean).map(s => { const [h, subject, body] = s.split('\x1f'); return { sha: h, subject, body: body ?? '' }; });
  const fail = pc.fileRules({ files, commits, forbidden: FORBIDDEN });
  const list = files.map(f => f.path);
  return {
    files, commits,
    check: { name: 'Files changed', status: fail.length ? 'fail' : 'pass', summary: `${list.length} file${list.length === 1 ? '' : 's'}${list.length ? `: ${list.slice(0, 5).join(', ')}${list.length > 5 ? ', …' : ''}` : ''}`, details: fail },
  };
}

async function unitCheck(log) {
  log('running the unit tests…');
  const r = await run('npm', ['test'], { cwd: CHECKER, timeoutMs: 10 * 60_000 });
  const t = pc.parseNodeTest(r.stdout + r.stderr);
  const ok = r.code === 0 && t.fail === 0;
  return { name: 'Unit tests', status: ok ? 'pass' : 'fail', summary: t.tests !== null ? `${t.pass}/${t.tests} pass` : `exit code ${r.code}`, details: ok ? [] : (t.failing.length ? t.failing : [(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')]) };
}

async function e2eCheck(log) {
  const pkg = JSON.parse(readFileSync(join(CHECKER, 'package.json'), 'utf8'));
  if (!pkg.scripts?.['test:e2e']) return { name: 'Browser journeys', status: 'skip', summary: 'this version of the site has none' };
  log('running the browser journeys (a few minutes)…');
  const r = await run('npm', ['run', 'test:e2e'], { cwd: CHECKER, timeoutMs: 20 * 60_000, env: { TMP, TEMP: TMP } });
  const out = `${r.stdout}\n${r.stderr}`;
  const tally = out.match(/(\d+)\s+(?:journeys?|checks?)\s+pass/i) || out.match(/pass(?:ed)?\D{0,3}(\d+)/i);
  const failing = [...out.matchAll(/^\s*(?:✖|FAIL|not ok)\s+(.+)$/gim)].map(m => m[1].trim()).slice(0, 10);
  const ok = r.code === 0;
  return { name: 'Browser journeys', status: ok ? 'pass' : 'fail', summary: ok ? (tally ? `${tally[1]} pass` : 'all pass') : `${failing.length || 'some'} failed`, details: ok ? [] : (failing.length ? failing : [out.trim().split('\n').slice(-3).join(' ')]) };
}

// open one page on one side; scroll the changed part into view if we know what it is
async function look(tab, url, focus, width) {
  await tab.goto(url);
  const metrics = await tab.eval(`(${pc.pageMetrics})(${width})`);
  let focused = false;
  if (focus) {
    focused = await tab.eval(`(() => { const el = document.querySelector(${JSON.stringify(focus)}); if (!el) return false; el.scrollIntoView({ block: 'start', behavior: 'instant' }); scrollBy({ top: -80, behavior: 'instant' }); return true; })()`).catch(() => false);
    await sleep(900);
  }
  const shot = await tab.screenshot();
  return { metrics, shot, focused, errors: [...tab.errors], failed: [...tab.failed], bytes: tab.bytes };
}

async function composite(browser, dir, name, title, beforeFile, afterFile, wide) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#f6f2ea;color:#1d2b2a;font:600 17px system-ui,sans-serif}
    h1{font-size:19px;margin:20px 24px 0}.row{display:flex;gap:20px;padding:16px 24px 24px;align-items:flex-start}
    figure{margin:0;flex:1;min-width:0}figcaption{margin:0 0 8px;color:#2a6f67}
    img{width:100%;display:block;border:1px solid #cdd8d5;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.08)}
  </style><h1>${title}</h1><div class="row"><figure><figcaption>Before: main</figcaption><img src="${beforeFile}"></figure><figure><figcaption>After: this fix</figcaption><img src="${afterFile}"></figure></div>`;
  const htmlFile = join(dir, `${name}.html`);
  writeFileSync(htmlFile, html);
  const tab = await browser.newPage({ width: wide ? 1700 : 1000, height: 600 });
  await tab.goto(pathToFileURL(htmlFile).href, { settleMs: 300 });
  const png = await tab.screenshot({ full: true });
  await tab.close();
  const file = join(dir, `${name}.png`);
  writeFileSync(file, png);
  return file;
}

export async function visualChecks({ pages, sizes, focus, outDir, label, log = () => {}, beforeRoot = BASE, afterRoot = CHECKER }) {
  const checks = [], attachments = [];
  const before = await serveSite(beforeRoot), after = await serveSite(afterRoot);
  const browser = await launch({ tmpRoot: TMP });
  try {
    const errorsNew = [], headFail = [], headWarn = [], hindiNew = [], weight = [];
    for (const size of sizes) {
      const dims = SIZES[size];
      const [tb, ta] = [await browser.newPage({ ...dims, init: VISIT_INIT }), await browser.newPage({ ...dims, init: VISIT_INIT })];
      const fail = [], warn = [];
      for (const page of pages) {
        log(`looking at ${page} on ${size}…`);
        const b = await look(tb, before.url + page, focus, dims.width);
        const a = await look(ta, after.url + page, focus, dims.width);
        if (focus && !a.focused) warn.push(`${page}: could not find "${focus}" on the page, so the screenshot shows the top`);
        const lay = pc.compareLayout(b.metrics, a.metrics);
        fail.push(...lay.fail.map(x => `${page}: ${x}`)); warn.push(...lay.warn.map(x => `${page}: ${x}`));
        errorsNew.push(...pc.compareErrors(b, a).map(x => `${page} (${size}): ${x}`));
        if (size === sizes.at(-1)) {
          const h = pc.compareHead(b.metrics.head, a.metrics.head);
          headFail.push(...h.fail.map(x => `${page}: ${x}`)); headWarn.push(...h.warn.map(x => `${page}: ${x}`));
          const w = pc.compareWeight(b, a); if (w) weight.push(`${page}: ${w}`);
          if (a.metrics.noAlt.length > b.metrics.noAlt.length) headFail.push(`${page}: ${a.metrics.noAlt.length - b.metrics.noAlt.length} new image(s) without alt text`);
        }
        const name = `${slug(page)}-${size}`;
        writeFileSync(join(outDir, `before-${name}.png`), b.shot);
        writeFileSync(join(outDir, `after-${name}.png`), a.shot);
        attachments.push(await composite(browser, outDir, `compare-${name}`, `${label} · ${page} · ${size} (${dims.width}×${dims.height})`, `before-${name}.png`, `after-${name}.png`, size === 'desktop'));
      }
      await tb.close(); await ta.close();
      checks.push({ name: `Layout on ${size}`, status: fail.length ? 'fail' : warn.length ? 'warn' : 'pass', summary: fail.length ? `${fail.length} problem${fail.length > 1 ? 's' : ''}` : warn.length ? `${warn.length} thing${warn.length > 1 ? 's' : ''} to look at` : 'no new problems', details: [...fail, ...warn] });
    }
    // Hindi: the same pages with the site switched to Hindi; English that is new on this branch is missing its Hindi
    const [hb, ha] = [await browser.newPage({ ...SIZES.desktop, init: HINDI_INIT }), await browser.newPage({ ...SIZES.desktop, init: HINDI_INIT })];
    for (const page of pages) {
      log(`checking ${page} in Hindi…`);
      await hb.goto(before.url + page); await ha.goto(after.url + page);
      const [eb, ea] = [await hb.eval(`(${pc.untranslatedText})()`), await ha.eval(`(${pc.untranslatedText})()`)];
      hindiNew.push(...pc.compareHindi(eb, ea).map(x => `${page}: "${x}"`));
    }
    await hb.close(); await ha.close();
    checks.push({ name: 'Console and network errors', status: errorsNew.length ? 'fail' : 'pass', summary: errorsNew.length ? `${errorsNew.length} new` : 'none new', details: [...new Set(errorsNew)] });
    checks.push({ name: 'Search tags', status: headFail.length ? 'fail' : headWarn.length ? 'warn' : 'pass', summary: headFail.length ? `${headFail.length} broken` : headWarn.length ? `${headWarn.length} changed` : 'unchanged', details: [...headFail, ...headWarn] });
    checks.push({ name: 'Hindi', status: hindiNew.length ? 'fail' : 'pass', summary: hindiNew.length ? `${hindiNew.length} new English line${hindiNew.length > 1 ? 's' : ''} without Hindi` : 'every new line has Hindi', details: hindiNew });
    checks.push({ name: 'Page weight', status: weight.length ? 'warn' : 'pass', summary: weight.length ? 'heavier' : 'about the same', details: weight });
  } finally {
    await browser.close(); await before.close(); await after.close();
  }
  return { checks, attachments };
}

export async function checkBranch({ ticket, branch, pages, focus, sizes, unit = true, e2e = true, baseRef = 'origin/main', log = m => console.error(m) }) {
  const started = Date.now();
  await git(REPO, 'fetch', '--quiet', 'origin'); // best effort: an offline check still compares with the last main it saw
  const sha = await gitOut(REPO, 'rev-parse', '--verify', `${branch}^{commit}`);
  const main = await gitOut(REPO, 'rev-parse', baseRef);
  const base = await gitOut(REPO, 'merge-base', main, sha);
  await placeAt(CHECKER, sha);
  await placeAt(BASE, base);
  const outDir = join(STATE, 'reports', ticket ?? slug(branch), sha.slice(0, 7));
  mkdirSync(outDir, { recursive: true });

  const checks = [];
  const f = await filesCheck(base, sha);
  checks.push(f.check);
  if (unit) checks.push(await unitCheck(log)); else checks.push({ name: 'Unit tests', status: 'skip', summary: 'skipped' });
  const v = await visualChecks({ pages, sizes, focus, outDir, label: ticket ?? branch, log });
  checks.push(...v.checks);
  if (e2e) checks.push(await e2eCheck(log)); else checks.push({ name: 'Browser journeys', status: 'skip', summary: 'skipped' });

  const report = { ticket, branch, sha, base, main, pages, sizes, focus, checks, verdict: pc.verdictOf(checks), attachments: v.attachments, files: f.files, commits: f.commits.map(c => ({ sha: c.sha, subject: c.subject })), at: new Date().toISOString(), ms: Date.now() - started };
  const summary = pc.chatSummary(report);
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, 'report.md'), `${summary}\n\n## Every detail\n\n${checks.map(c => `### ${c.name}: ${c.status}\n${c.summary}\n${(c.details ?? []).map(d => `- ${d}`).join('\n')}`).join('\n\n')}\n`);
  return { report, summary, outDir };
}

export async function main(argv) {
  const { values: v } = parseArgs({ args: argv, options: {
    ticket: { type: 'string' }, branch: { type: 'string' }, pages: { type: 'string' }, focus: { type: 'string' }, sizes: { type: 'string' },
    e2e: { type: 'string', default: 'on' }, unit: { type: 'string', default: 'on' }, base: { type: 'string', default: 'origin/main' },
  } });
  const t = v.ticket ? get(v.ticket) : null;
  const branch = v.branch ?? t?.branch;
  if (!branch) throw new Error(t ? `${t.id} has no branch yet: kv-builder sets it when the fix is ready` : 'give --ticket KV-### or --branch <name>');
  const pages = (v.pages ?? t?.page ?? '/').split(',').map(s => s.trim()).filter(Boolean);
  const sizes = (v.sizes ? v.sizes.split(',') : t?.sizes ?? Object.keys(SIZES)).map(s => s.trim()).filter(s => SIZES[s]);
  const { report, summary, outDir } = await checkBranch({ ticket: t?.id, branch, pages, focus: v.focus ?? t?.focus, sizes, unit: v.unit !== 'off', e2e: v.e2e !== 'off', baseRef: v.base });
  if (t) update(t.id, { status: report.verdict === 'pass' ? 'passed' : 'failed', sha: report.sha, report: join(outDir, 'report.json') }, { by: 'kv-checker', note: `check ${report.verdict}` });
  console.log(summary);
  console.log(`\nReport: ${join(outDir, 'report.md')}`);
  console.log(`Attach: ${report.attachments.join(' ')}`);
  return report.verdict === 'pass' ? 0 : 2;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(`The check could not run: ${e.message}`); process.exit(1); });
}
