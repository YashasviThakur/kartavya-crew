import test from 'node:test';
import assert from 'node:assert/strict';
import { scratch } from './helpers.js';
import { create, update, get, board, normalizeId, load } from '../tools/lib/store.mjs';

test('ticket ids are numbered in order and read back however they are typed', () => {
  const { dir, done } = scratch('store');
  try {
    const a = create({ title: 'Plans text cut off on phones', page: '/', sizes: 'phone', reporter: 'gurinder' }, { dir });
    const b = create({ title: 'Hindi missing on How it works', kind: 'change', page: '/how-it-works' }, { dir });
    assert.equal(a.id, 'KV-001');
    assert.equal(b.id, 'KV-002');
    for (const typed of ['kv-2', 'KV-002', '2', '#2', 'kv2']) assert.equal(normalizeId(typed), 'KV-002');
    assert.equal(get('kv-1', { dir }).title, 'Plans text cut off on phones');
    assert.deepEqual(a.sizes, ['phone']);
    assert.deepEqual(b.sizes, ['phone', 'tablet', 'desktop']); // no size given: check all three
  } finally { done(); }
});

test('bad input is refused with a message an agent can act on', () => {
  const { dir, done } = scratch('store');
  try {
    assert.throws(() => create({ title: '' }, { dir }), /needs a title/);
    assert.throws(() => create({ title: 'x', page: 'how-it-works' }, { dir }), /a page is a path/);
    assert.throws(() => create({ title: 'x', sizes: 'watch' }, { dir }), /unknown screen size/);
    assert.throws(() => create({ title: 'x', kind: 'feature' }, { dir }), /kind must be/);
    create({ title: 'ok' }, { dir });
    assert.throws(() => update('KV-001', { status: 'done' }, { dir }), /status must be/);
    assert.throws(() => update('KV-009', { status: 'closed' }, { dir }), /no ticket KV-009/);
    assert.throws(() => normalizeId('abc'), /not a ticket id/);
  } finally { done(); }
});

test('status changes are kept in the history with who made them', () => {
  const { dir, done } = scratch('store');
  try {
    create({ title: 'Footer link broken' }, { dir });
    update('KV-001', { status: 'building', branch: 'crew/kv-001-footer' }, { dir, by: 'kv-builder' });
    update('KV-001', { status: 'checking', focus: 'footer .foot' }, { dir, by: 'kv-builder', note: 'fixed the href' });
    const t = get('KV-001', { dir });
    assert.equal(t.status, 'checking');
    assert.equal(t.branch, 'crew/kv-001-footer');
    assert.deepEqual(t.history.map(h => [h.by, h.status]), [['kv-triager', 'new'], ['kv-builder', 'building'], ['kv-builder', 'checking']]);
    assert.equal(t.history.at(-1).note, 'fixed the href');
    assert.equal(load(dir).next, 2);
  } finally { done(); }
});

test('the board shows what waits for a person first, and recent releases', () => {
  const { dir, done } = scratch('store');
  try {
    assert.match(board({ dir }), /No tickets yet/);
    create({ title: 'A', reporter: 'aaditi' }, { dir });
    create({ title: 'B' }, { dir });
    create({ title: 'C' }, { dir });
    update('KV-001', { status: 'passed' }, { dir });
    update('KV-002', { status: 'shipped', pr: 'https://github.com/x/y/pull/9' }, { dir });
    const b = board({ dir });
    assert.match(b, /2 open · 1 waiting for a person · 1 shipped/);
    assert.ok(b.indexOf('Waiting for a person') < b.indexOf('In progress'));
    assert.match(b, /\*\*KV-001\*\* A \(Checked, waiting for approval\) · \/ · reported by aaditi/);
    assert.match(b, /\*\*KV-002\*\* B · \/ · reported by unknown · \[pull request\]\(https:\/\/github.com\/x\/y\/pull\/9\)/);
  } finally { done(); }
});
