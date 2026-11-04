import test from 'node:test';
import assert from 'node:assert/strict';
import * as pc from '../tools/lib/pagecheck.mjs';
import { FORBIDDEN } from '../tools/config.mjs';

const page = over => ({ width: 390, overflowX: false, scrollWidth: 390, wide: [], clipped: [], small: [], broken: [], noAlt: [], head: { title: 'T', description: 'D', canonical: 'https://x/', robots: 'index, follow', lang: 'en', h1: ['Main'], ogImage: null, jsonld: 3 }, ...over });

test('only problems the fix brought in count; ones already on main do not', () => {
  const before = page({ clipped: ['p.old'], small: ['a.tiny'] });
  const after = page({ clipped: ['p.old', 'h3.new-card'], small: ['a.tiny'] });
  assert.deepEqual(pc.compareLayout(before, after), { fail: [], warn: ['text cut off: h3.new-card'] });
});

test('sideways scrolling and broken images fail the check', () => {
  const r = pc.compareLayout(page(), page({ overflowX: true, scrollWidth: 470, wide: ['section#plans > div.grid'], broken: ['/media/x.jpg'] }));
  assert.equal(r.fail.length, 2);
  assert.match(r.fail[0], /scrolls sideways \(470px wide on a 390px screen\): section#plans > div\.grid/);
  assert.match(r.fail[1], /broken image: \/media\/x\.jpg/);
  // already scrolling sideways on main: not this fix's fault
  assert.deepEqual(pc.compareLayout(page({ overflowX: true }), page({ overflowX: true })).fail, []);
});

test('new console errors are reported once, whatever port the side was served on', () => {
  const b = { errors: ['old error'], failed: ['404 http://127.0.0.1:51001/missing.png'] };
  const a = { errors: ['old error', 'TypeError: x is undefined', 'TypeError: x is undefined'], failed: ['404 http://127.0.0.1:51002/missing.png'] };
  assert.deepEqual(pc.compareErrors(b, a), ['TypeError: x is undefined']);
});

test('search tags: a lost tag fails, a changed one is only shown', () => {
  const head = page().head;
  assert.deepEqual(pc.compareHead(head, { ...head }), { fail: [], warn: [] });
  const r = pc.compareHead(head, { ...head, description: null, title: 'New title', h1: ['A', 'B'], jsonld: 1 });
  assert.deepEqual(r.fail, ['the description tag is gone', 'the page should have one main heading, now has 2', 'structured data blocks went from 3 to 1']);
  assert.deepEqual(r.warn, ['title changed: "T" -> "New title"']);
});

test('Hindi: only English that is new on the branch is flagged', () => {
  assert.deepEqual(pc.compareHindi(['Old untranslated'], ['Old untranslated', 'Book a pilot visit']), ['Book a pilot visit']);
});

test('the founder\'s file rules: kept-out files, Claude co-author lines, empty branches', () => {
  const files = [{ path: 'index.html' }, { path: 'portal-bundles.css' }, { path: 'Kartavya-Features-and-Products-Reference.pdf' }, { path: '.env.local' }, { path: 'backend/lambda/core.js' }];
  const commits = [{ sha: 'abc1234def', body: 'Co-Authored-By: Claude Opus <noreply@anthropic.com>' }, { sha: 'fff0000', body: '' }];
  assert.deepEqual(pc.fileRules({ files, commits, forbidden: FORBIDDEN }), [
    'portal-bundles.css must not be changed',
    'Kartavya-Features-and-Products-Reference.pdf must not be changed',
    '.env.local must not be changed',
    'commit abc1234 has a Co-Authored-By: Claude line',
  ]);
  assert.deepEqual(pc.fileRules({ files: [], commits: [], forbidden: FORBIDDEN }), ['the branch changes nothing compared with main']);
});

test('unit test output is read from node:test\'s summary', () => {
  const out = 'ℹ tests 141\nℹ suites 0\nℹ pass 139\nℹ fail 2\n✖ failing tests:\n✖ logout cancels the token (3.2ms)\n✖ wrong codes lock only the address (1.1ms)\n';
  assert.deepEqual(pc.parseNodeTest(out), { tests: 141, pass: 139, fail: 2, failing: ['logout cancels the token', 'wrong codes lock only the address'] });
});

test('page weight: small changes pass, a big jump is shown', () => {
  assert.equal(pc.compareWeight({ bytes: 2_000_000 }, { bytes: 2_100_000 }), null);
  assert.equal(pc.compareWeight({ bytes: 2_000_000 }, { bytes: 3_500_000 }), 'the page now downloads 3.5 MB (was 2.0 MB)');
});

test('the chat summary leads with the verdict and lists what to look at', () => {
  const s = pc.chatSummary({
    ticket: 'KV-004', branch: 'crew/kv-004-plans', sha: 'a1b2c3d4e5', base: 'f6e5d4c3b2', ms: 61000,
    verdict: 'fail',
    checks: [
      { name: 'Unit tests', status: 'pass', summary: '141/141 pass' },
      { name: 'Hindi', status: 'fail', summary: '1 new English line without Hindi', details: ['/: "Book a pilot visit"'] },
    ],
    attachments: ['D:/x/compare-home-phone.png'],
  });
  assert.match(s, /^\*\*KV-004 check: FAIL\*\* · `crew\/kv-004-plans` @ a1b2c3d compared with main @ f6e5d4c/);
  assert.match(s, /\| Hindi \| ❌ 1 new English line without Hindi \|/);
  assert.match(s, /- ❌ Hindi: \/: "Book a pilot visit"/);
  assert.match(s, /compare-home-phone\.png/);
  assert.equal(pc.verdictOf([{ status: 'pass' }, { status: 'warn' }]), 'pass');
  assert.equal(pc.verdictOf([{ status: 'pass' }, { status: 'fail' }]), 'fail');
});

test('browser journey output is read the way the site\'s e2e/run.mjs prints it', async () => {
  const { parseE2E } = await import('../tools/check.mjs');
  const out = '\nphone\n  FAIL  Back from FAQs  ->  landed on /care\n\ntablet\n\n250 passed, 1 failed\n\n[phone] Back from FAQs: landed on /care\n';
  assert.deepEqual(parseE2E(out), { passed: 250, failed: 1, failing: ['phone: Back from FAQs: landed on /care'] });
  assert.deepEqual(parseE2E('\nphone\n\n251 passed, 0 failed\n'), { passed: 251, failed: 0, failing: [] });
});
