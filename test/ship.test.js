import test from 'node:test';
import assert from 'node:assert/strict';
import { shipDecision, prBody } from '../tools/ship.mjs';
import { notesMaterial, shippedSince } from '../tools/notes.mjs';

const ticket = { id: 'KV-004', title: 'Plans text cut off on phones', status: 'passed', branch: 'crew/kv-004-plans', reporter: 'gurinder', page: '/', detail: 'The Care+ card text is cut off' };
const report = { verdict: 'pass', branch: 'crew/kv-004-plans', sha: 'aaaaaaa1111', main: 'mmmmmmm0000', checks: [{ name: 'Unit tests', status: 'pass', summary: '141/141 pass' }] };
const ok = { ticket, report, branchHead: 'aaaaaaa1111', mainNow: 'mmmmmmm0000', approvedBy: 'yashasvi' };

test('a passed, unchanged, approved fix may ship', () => {
  assert.deepEqual(shipDecision(ok), { ok: true, reason: 'checked, unchanged since, and approved' });
});

test('everything else is refused, with the reason the shipper repeats in the room', () => {
  const no = over => shipDecision({ ...ok, ...over }).reason;
  assert.match(no({ approvedBy: '' }), /say who approved it/);
  assert.match(no({ report: null }), /has not been checked yet/);
  assert.match(no({ report: { ...report, verdict: 'fail' } }), /last check of KV-004 failed/);
  assert.match(no({ branchHead: 'bbbbbbb2222' }), /has new commits since it was checked \(aaaaaaa -> bbbbbbb\)/);
  assert.match(no({ mainNow: 'nnnnnnn1111' }), /main moved since the check/);
  assert.match(no({ ticket: { ...ticket, status: 'shipped', pr: 'https://github.com/x/y/pull/3' } }), /already shipped \(https/);
  assert.match(no({ ticket: { ...ticket, branch: undefined } }), /has no branch yet/);
  assert.match(no({ report: { ...report, branch: 'crew/other' } }), /check was of crew\/other/);
});

test('the pull request says who reported, what was checked and who approved', () => {
  const body = prBody({ ticket, report, approvedBy: 'yashasvi' });
  assert.match(body, /Reported by gurinder/);
  assert.match(body, /Checked by kv-checker at aaaaaaa against main mmmmmmm/);
  assert.match(body, /\| Unit tests \| pass · 141\/141 pass \|/);
  assert.match(body, /Approved for release by yashasvi/);
  assert.doesNotMatch(body, /Co-Authored-By/i);
});

test('release-note material lists what shipped this week by page, and says so when nothing did', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const t = (id, page, at, status = 'shipped') => ({ id, page, kind: 'bug', title: `fix ${id}`, reporter: 'aaditi', status, updated: at, history: [{ status, at }] });
  const tickets = [t('KV-001', '/', '2026-11-06T10:00:00Z'), t('KV-002', '/how-it-works', '2026-11-05T10:00:00Z'), t('KV-003', '/', '2026-10-20T10:00:00Z'), t('KV-004', '/', '2026-11-06T11:00:00Z', 'passed')];
  assert.deepEqual(shippedSince(tickets, 7, now).map(x => x.id), ['KV-002', 'KV-001']);
  assert.equal(notesMaterial([], 7), 'Nothing shipped in the last 7 days.');
});

test('it never releases into the live Kartavya repo, by name or by push address', async () => {
  const { targetProblem } = await import('../tools/ship.mjs');
  const sandbox = 'YashasviThakur/kartavya-crew-sandbox';
  assert.equal(targetProblem({ repo: sandbox, pushUrl: 'https://github.com/YashasviThakur/kartavya-crew-sandbox.git' }), null);
  assert.match(targetProblem({ repo: 'YashasviThakur/kartavya', pushUrl: 'https://github.com/YashasviThakur/kartavya.git' }), /refusing to release into the live repo/);
  assert.match(targetProblem({ repo: sandbox, pushUrl: 'https://github.com/YashasviThakur/kartavya.git' }), /pushes to the live repo/);
  assert.match(targetProblem({ repo: sandbox, pushUrl: 'git@github.com:YashasviThakur/kartavya.git' }), /pushes to the live repo/);
  assert.match(targetProblem({ repo: sandbox, pushUrl: 'https://github.com/someone/else.git' }), /not YashasviThakur\/kartavya-crew-sandbox/);
});
