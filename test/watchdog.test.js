import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, diffHealth, incidentMessage, dailyDue, changeMessage } from '../watchdog/logic.mjs';
import { startWatchdog } from '../watchdog/watchdog.mjs';
import { register } from '../watchdog/switch.mjs';
import { fakeSwitch } from './fake-switch.js';

const healthy = { ok: true, base: 'https://www.thekartavya.com', at: '2026-11-04T10:00:00Z', critical: 0, warnings: 0, checks: [{ name: 'Page /', ok: true, severity: 'critical', detail: '200' }] };
const paused = { ok: false, base: 'https://www.thekartavya.com', at: '2026-11-04T16:00:00Z', critical: 2, warnings: 0, checks: [{ name: 'Hosting', ok: false, severity: 'critical', detail: 'Vercel says DEPLOYMENT_PAUSED' }, { name: 'Page /', ok: false, severity: 'critical', detail: 'answered 503' }] };
const wait = (cond, ms = 5000) => new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { if (cond()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timed out')); } }, 20); });

test('what people ask the watchdog', () => {
  assert.equal(parseCommand('@kv-watchdog check now please'), 'check');
  assert.equal(parseCommand('@kv-watchdog is the site up?'), 'check');
  assert.equal(parseCommand('@kv-watchdog last result'), 'last');
  assert.equal(parseCommand('@kv-watchdog hi'), 'help');
});

test('it speaks up only when something breaks or recovers', () => {
  assert.deepEqual(diffHealth(healthy, healthy), { changed: false, first: false, broke: [], fixed: [] });
  assert.deepEqual(diffHealth(healthy, paused), { changed: true, first: false, broke: ['Hosting', 'Page /'], fixed: [] });
  assert.deepEqual(diffHealth(paused, paused).changed, false);
  const back = diffHealth(paused, healthy);
  assert.deepEqual(back.fixed, ['Hosting', 'Page /']);
  assert.match(changeMessage(healthy, back), /^Back to normal\. Fixed: Hosting, Page \//);
  assert.match(incidentMessage(paused, ['Hosting', 'Page /']), /^@kv-triager please open an incident ticket: 2 checks just started failing on www\.thekartavya\.com\.\n- Hosting: Vercel says DEPLOYMENT_PAUSED/);
});

test('the morning summary is due once a day after 09:00 India time', () => {
  assert.equal(dailyDue(null, new Date('2026-11-04T03:00:00Z')), null);          // 08:30 IST
  assert.equal(dailyDue(null, new Date('2026-11-04T03:31:00Z')), '2026-11-04');  // 09:01 IST
  assert.equal(dailyDue('2026-11-04', new Date('2026-11-04T10:00:00Z')), null);
});

test('registration sends the agent protocol\'s fields with the registration key', async () => {
  const sw = await fakeSwitch();
  try {
    const r = await register(sw.url, 'reg-key', { name: 'kv-watchdog', displayName: 'Kartavya watchdog', description: 'x' });
    assert.deepEqual(r, { id: 'a-1', api_key: 'agent-key' });
    const body = sw.calls.find(c => c.url === '/agents').json;
    assert.equal(body.integration_profile.connection_model, 'always_on');
    assert.deepEqual(body.integration_profile.event_reporting, []);
    await assert.rejects(register(sw.url, 'wrong', { name: 'x', description: 'x' }), /401/);
  } finally { sw.close(); }
});

test('on a live connection it answers pings, reports on start, and answers "@kv-watchdog check" in the thread', async () => {
  const sw = await fakeSwitch();
  const results = [paused, paused, healthy];
  const cfg = { api: sw.url, agentId: 'a-1', apiKey: 'agent-key', connectionId: '11111111-2222-3333-4444-555555555555' };
  const w = await startWatchdog({ cfg, everyMin: 600, check: async () => results.shift() ?? healthy, save: () => {} });
  try {
    // on start: the first look, and an incident for kv-triager because the site is down
    await wait(() => sw.posts.length >= 2);
    assert.match(sw.posts[0].content, /kv-watchdog is on duty/);
    assert.equal(sw.posts[0].room_id, 'room-ops');
    assert.match(sw.posts[1].content, /^@kv-triager please open an incident ticket/);
    // liveness: a ping gets a pong straight away
    sw.send({ type: 'ping' });
    await wait(() => sw.pongs.length >= 1);
    assert.equal(sw.pongs[0].type, 'pong');
    // an addressed message: replies go into its thread through post_message
    sw.send({ event: 'message', id: 5, data: { type: 'message', room_id: 'room-ops', sequence: 5, payload: { addressed: true, sender: '@switch-user-1:x', sender_name: 'yashasvi', message_id: 'm-9', body: '@kv-watchdog check now', thread_id: null, attachments: [] } } });
    await wait(() => sw.posts.length >= 4);
    assert.deepEqual(sw.posts.slice(2).map(p => [p.via, p.thread_id]), [['op', 'm-9'], ['op', 'm-9']]);
    assert.match(sw.posts[3].content, /has a problem/);
    // a message that is not for the watchdog is ignored
    sw.send({ event: 'message', id: 6, data: { type: 'message', room_id: 'room-ops', sequence: 6, payload: { addressed: false, body: 'lunch?', message_id: 'm-10' } } });
    sw.send({ type: 'ping' });
    await wait(() => sw.pongs.length >= 2);
    assert.equal(sw.pongs.at(-1).cursor, 6);
    assert.equal(sw.posts.length, 4);
    // every call carried the agent's own key
    assert.ok(sw.calls.filter(c => c.url !== '/health').every(c => c.auth === 'Bearer agent-key'));
  } finally { w.stop(); sw.close(); }
});
