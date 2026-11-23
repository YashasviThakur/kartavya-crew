#!/usr/bin/env node
// How well does kv-checker catch what it is meant to catch, and does it leave good fixes alone?
//   node eval/checker-eval.mjs            writes eval/results/checker.json and prints a table
// Each case is a small change made to a made-up copy of the Kartavya page ("main"). The defects are seeded by us,
// so this measures the checker against known problems, not against problems nobody thought of. Needs Chrome.
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { visualChecks } from '../tools/check.mjs';
import { fileRules, verdictOf } from '../tools/lib/pagecheck.mjs';
import { FORBIDDEN } from '../tools/config.mjs';
import { chromePath } from '../tools/lib/cdp.mjs';

if (!chromePath()) { console.error('Chrome is not installed'); process.exit(1); }

const HI = { 'Care for your parents': 'अपने माता-पिता की देखभाल', 'Know they are okay.': 'जानिए वे ठीक हैं।' };
// "main": a page with the tags the checker guards (title, description, canonical, one heading, structured data)
const page = ({ body = '', hi = {}, head = {} } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${head.title ?? 'Kartavya test'}</title>
${head.description === null ? '' : '<meta name="description" content="A test page">'}
${head.canonical === null ? '' : '<link rel="canonical" href="https://www.thekartavya.com/">'}
${head.jsonld === null ? '' : '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Kartavya"}</script>'}
<style>body{margin:0;font:16px system-ui}.card{width:100%;padding:12px;box-sizing:border-box}a.btn{display:inline-block;padding:12px 16px}</style></head>
<body><h1>Care for your parents</h1><p class="lead">Know they are okay.</p>${body}
<script>
  const HI = ${JSON.stringify({ ...HI, ...hi })};
  if (localStorage.getItem('kv-lang') === 'hi') for (const el of document.querySelectorAll('h1,h2,p,a,div')) if (HI[el.textContent]) el.textContent = HI[el.textContent];
</script></body></html>`;

const PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const hindi = (en, hi) => ({ hi: { [en]: hi } });

// kind: defect (must fail), soft (must be flagged, a warning is enough), clean (must not fail)
const CASES = [
  { id: 'D1', kind: 'defect', what: 'phone layout scrolls sideways', by: 'Layout on phone', fix: page({ body: '<div class="card" style="width:520px">Plans</div>', ...hindi('Plans', 'योजनाएँ') }) },
  { id: 'D2', kind: 'defect', what: 'new console error', by: 'Console and network errors', fix: page({ body: '<script>console.error("plans widget failed")</script>' }) },
  { id: 'D3', kind: 'defect', what: 'English line with no Hindi', by: 'Hindi', fix: page({ body: '<p>Book a pilot visit</p>' }) },
  { id: 'D4', kind: 'defect', what: 'broken image', by: 'Layout on phone', fix: page({ body: '<img src="/missing.png" alt="Plans" width="200" height="100">' }) },
  { id: 'D5', kind: 'defect', what: 'canonical tag removed', by: 'Search tags', fix: page({ head: { canonical: null } }) },
  { id: 'D6', kind: 'defect', what: 'meta description removed', by: 'Search tags', fix: page({ head: { description: null } }) },
  { id: 'D7', kind: 'defect', what: 'second main heading', by: 'Search tags', fix: page({ body: '<h1>Plans</h1>' , ...hindi('Plans', 'योजनाएँ') }) },
  { id: 'D8', kind: 'defect', what: 'new image with no alt text', by: 'Search tags', fix: page({ body: `<img src="${PX}" width="40" height="40">` }) },
  { id: 'D9', kind: 'defect', what: 'structured data removed', by: 'Search tags', fix: page({ head: { jsonld: null } }) },
  { id: 'D10', kind: 'defect', what: 'a request that fails (404)', by: 'Console and network errors', fix: page({ body: '<script>fetch("/api/plans")</script>' }) },
  { id: 'S1', kind: 'soft', what: 'page gets 400 KB heavier', by: 'Page weight', fix: page({ body: `<script>/*${'x'.repeat(400_000)}*/</script>` }) },
  { id: 'S2', kind: 'soft', what: 'a tap target smaller than a fingertip', by: 'Layout on phone', fix: page({ body: '<p><a href="/p" style="display:inline-block;width:12px;height:12px">go</a></p>' }) },
  { id: 'S3', kind: 'soft', what: 'page title changed', by: 'Search tags', fix: page({ head: { title: 'Kartavya plans' } }) },
  { id: 'F1', kind: 'files', what: 'touches a file the founder keeps out', files: [{ status: 'M', path: 'dawn.css' }], commits: [{ sha: 'a'.repeat(40), body: '' }] },
  { id: 'F2', kind: 'files', what: 'a Claude co-author line in a commit', files: [{ status: 'M', path: 'index.html' }], commits: [{ sha: 'b'.repeat(40), body: 'Co-Authored-By: Claude <noreply@anthropic.com>' }] },
  { id: 'F3', kind: 'files', what: 'the branch changes nothing', files: [], commits: [] },
  { id: 'F4', kind: 'files', what: 'a .env file is committed', files: [{ status: 'A', path: 'backend/.env' }], commits: [{ sha: 'c'.repeat(40), body: '' }] },
  { id: 'C1', kind: 'clean', what: 'new paragraph, with Hindi', fix: page({ body: '<p>Book a pilot visit</p>', ...hindi('Book a pilot visit', 'पायलट विज़िट बुक करें') }) },
  { id: 'C2', kind: 'clean', what: 'no change at all', fix: page() },
  { id: 'C3', kind: 'clean', what: 'new card that fits the phone, with Hindi', fix: page({ body: '<div class="card">Plans</div>', ...hindi('Plans', 'योजनाएँ') }) },
  { id: 'C4', kind: 'clean', what: 'harmless console.log', fix: page({ body: '<script>console.log("ready")</script>' }) },
  { id: 'C5', kind: 'clean', what: 'new image with alt text', fix: page({ body: `<img src="${PX}" alt="A card" width="40" height="40">` }) },
  { id: 'C6', kind: 'clean', what: 'new heading, with Hindi', fix: page({ body: '<h2>Our plans</h2>', ...hindi('Our plans', 'हमारी योजनाएँ') }) },
  { id: 'C7', kind: 'clean', what: 'new full-size button link, with Hindi', fix: page({ body: '<p><a class="btn" href="/plans">See plans</a></p>', ...hindi('See plans', 'योजनाएँ देखें') }) },
];

const root = mkdtempSync(join(tmpdir(), 'kv-eval-'));
const dirs = { main: join(root, 'main') };
mkdirSync(dirs.main); writeFileSync(join(dirs.main, 'index.html'), page());

const rows = [];
for (const c of CASES) {
  const t0 = Date.now();
  let checks;
  if (c.kind === 'files') {
    const fail = fileRules({ files: c.files, commits: c.commits, forbidden: FORBIDDEN });
    checks = [{ name: 'Files changed', status: fail.length ? 'fail' : 'pass', details: fail }];
    c.by = 'Files changed';
  } else {
    const fix = join(root, c.id), out = join(root, `${c.id}-out`);
    mkdirSync(fix); mkdirSync(out); writeFileSync(join(fix, 'index.html'), c.fix);
    ({ checks } = await visualChecks({ pages: ['/'], sizes: ['phone', 'desktop'], outDir: out, label: c.id, beforeRoot: dirs.main, afterRoot: fix }));
  }
  const hit = checks.find(k => k.name === c.by);
  const flagged = checks.filter(k => k.status === 'fail' || k.status === 'warn').map(k => `${k.name}:${k.status}`);
  const failed = checks.some(k => k.status === 'fail');
  const ok = c.kind === 'defect' || c.kind === 'files' ? hit?.status === 'fail'
    : c.kind === 'soft' ? ['fail', 'warn'].includes(hit?.status)
    : !failed;
  const row = { id: c.id, kind: c.kind, what: c.what, expected: c.kind === 'clean' ? 'no failure' : `${c.by} flags it`, verdict: verdictOf(checks), flagged, ok, seconds: Math.round((Date.now() - t0) / 1000) };
  rows.push(row);
  console.log(`${ok ? 'ok  ' : 'MISS'} ${c.id.padEnd(4)} ${c.what}  [${flagged.join(', ') || 'nothing flagged'}]  ${row.seconds}s`);
}
rmSync(root, { recursive: true, force: true });

const of = k => rows.filter(r => r.kind === k);
const summary = {
  ranAt: new Date().toISOString(),
  defects: { caught: of('defect').filter(r => r.ok).length, of: of('defect').length },
  files: { caught: of('files').filter(r => r.ok).length, of: of('files').length },
  soft: { flagged: of('soft').filter(r => r.ok).length, of: of('soft').length },
  clean: { passed: of('clean').filter(r => r.ok).length, of: of('clean').length },
  cleanWarnings: of('clean').filter(r => r.flagged.length).length,
  medianSeconds: rows.map(r => r.seconds).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  rows,
};
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL('./results/checker.json', import.meta.url), JSON.stringify(summary, null, 2));
console.log(`\ndefects caught ${summary.defects.caught}/${summary.defects.of} · file rules ${summary.files.caught}/${summary.files.of} · soft flagged ${summary.soft.flagged}/${summary.soft.of} · clean fixes left alone ${summary.clean.passed}/${summary.clean.of} (${summary.cleanWarnings} with a warning)`);
process.exit(rows.every(r => r.ok) ? 0 : 3);
