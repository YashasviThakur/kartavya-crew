// Runs the real visual check in headless Chrome on two tiny made-up sites: "main" is fine; the "fix"
// makes the phone layout scroll sideways, throws a console error and adds English with no Hindi.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './helpers.js';
import { visualChecks } from '../tools/check.mjs';
import { chromePath } from '../tools/lib/cdp.mjs';

// a page that behaves like the real site's language switch: with kv-lang=hi it swaps known English for Hindi
const site = ({ extra = '', extraHi = false }) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Kartavya test</title>
<meta name="description" content="A test page"><link rel="canonical" href="https://www.thekartavya.com/">
<style>body{margin:0;font:16px system-ui}.card{width:100%;padding:12px;box-sizing:border-box}</style></head>
<body><h1>Care for your parents</h1><p class="lead">Know they are okay.</p>${extra}
<script>
  const HI = { 'Care for your parents': 'अपने माता-पिता की देखभाल', 'Know they are okay.': 'जानिए वे ठीक हैं।' ${extraHi ? ", 'Book a pilot visit': 'पायलट विज़िट बुक करें'" : ''} };
  if (localStorage.getItem('kv-lang') === 'hi') for (const el of document.querySelectorAll('h1,p,a')) if (HI[el.textContent]) el.textContent = HI[el.textContent];
</script></body></html>`;

test('the visual check finds what a fix broke, on phone, and keeps what main already had', { skip: !chromePath() && 'Chrome is not installed' }, async () => {
  const { dir, done } = scratch('visual');
  try {
    const main = join(dir, 'main'), fix = join(dir, 'fix'), out = join(dir, 'out');
    for (const d of [main, fix, out]) mkdirSync(d, { recursive: true });
    writeFileSync(join(main, 'index.html'), site({}));
    writeFileSync(join(fix, 'index.html'), site({ extra: '<div class="card" id="plans" style="width:520px">Plans</div><p><a href="/plans">Book a pilot visit</a></p><script>console.error("plans widget failed")</script>' }));
    const { checks, attachments } = await visualChecks({ pages: ['/'], sizes: ['phone', 'desktop'], focus: '#plans', outDir: out, label: 'KV-TEST', beforeRoot: main, afterRoot: fix });
    const by = Object.fromEntries(checks.map(c => [c.name, c]));
    if (process.env.KV_DEBUG) console.log(JSON.stringify(checks, null, 1));
    assert.equal(by['Layout on phone'].status, 'fail');
    assert.match(by['Layout on phone'].details.join('\n'), /scrolls sideways \(\d+px wide on a 390px screen\)/);
    assert.equal(by['Console and network errors'].status, 'fail');
    assert.match(by['Console and network errors'].details.join('\n'), /plans widget failed/);
    assert.equal(by.Hindi.status, 'fail');
    assert.deepEqual(by.Hindi.details, ['/: "Plans"', '/: "Book a pilot visit"']);
    assert.equal(by['Search tags'].status, 'pass');
    assert.equal(attachments.length, 2);
    for (const f of attachments) assert.ok(existsSync(f), `${f} was written`);
  } finally { done(); }
});

test('a clean fix passes every visual check', { skip: !chromePath() && 'Chrome is not installed' }, async () => {
  const { dir, done } = scratch('visual');
  try {
    const main = join(dir, 'main'), fix = join(dir, 'fix'), out = join(dir, 'out');
    for (const d of [main, fix, out]) mkdirSync(d, { recursive: true });
    writeFileSync(join(main, 'index.html'), site({}));
    writeFileSync(join(fix, 'index.html'), site({ extra: '<p><a href="/plans">Book a pilot visit</a></p>', extraHi: true }));
    const { checks } = await visualChecks({ pages: ['/'], sizes: ['phone'], outDir: out, label: 'KV-TEST', beforeRoot: main, afterRoot: fix });
    for (const c of checks) assert.notEqual(c.status, 'fail', `${c.name}: ${(c.details ?? []).join('; ')}`);
  } finally { done(); }
});
