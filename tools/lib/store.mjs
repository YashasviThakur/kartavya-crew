// The ticket store: one JSON file every agent reads and writes, so a ticket's number, status and history
// stay the same whichever agent (or person) looks. Writes take a lock file and replace the file in one
// rename, so two agents saving at the same moment can't leave half a file behind.
import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STATE } from '../config.mjs';
import { sitePath } from './cli.mjs';

export const STATUSES = ['new', 'needs-info', 'building', 'checking', 'passed', 'failed', 'shipped', 'closed'];
export const KINDS = ['bug', 'change', 'question', 'incident'];
const OPEN = new Set(['new', 'needs-info', 'building', 'checking', 'passed', 'failed']);
export const isOpen = t => OPEN.has(t.status);

const file = (dir = STATE) => join(dir, 'tickets.json');
const empty = () => ({ next: 1, tickets: [] });

// "kv-7", "KV-007", "7" and "#7" all mean KV-007
export function normalizeId(id) {
  const m = String(id ?? '').trim().match(/^(?:#|kv-?)?0*(\d{1,5})$/i);
  if (!m) throw new Error(`not a ticket id: ${id}`);
  return `KV-${m[1].padStart(3, '0')}`;
}

export function load(dir = STATE) {
  const f = file(dir);
  if (!existsSync(f)) return empty();
  return JSON.parse(readFileSync(f, 'utf8'));
}

function save(db, dir) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${file(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n');
  renameSync(tmp, file(dir));
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withLock(dir, fn) {
  mkdirSync(dir, { recursive: true });
  const lock = `${file(dir)}.lock`;
  for (let i = 0; ; i++) {
    try { closeSync(openSync(lock, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // a lock older than 30 s belongs to a process that died
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock); } catch {}
      if (i > 100) throw new Error('the ticket store is busy; try again');
      sleep(50);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch {} }
}

const clean = (v, max) => (v === undefined || v === null ? undefined : String(v).replace(/\s+/g, ' ').trim().slice(0, max) || undefined);
const sizesOf = v => {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(',')).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  const bad = list.filter(s => !['phone', 'tablet', 'desktop'].includes(s));
  if (bad.length) throw new Error(`unknown screen size: ${bad.join(', ')} (use phone, tablet, desktop)`);
  return list.length ? [...new Set(list)] : ['phone', 'tablet', 'desktop'];
};
const pageOf = v => {
  const p = sitePath(clean(v, 200) ?? '/') || '/';
  if (!p.startsWith('/')) throw new Error(`a page is a path on the site, like / or /how-it-works (got ${p})`);
  return p;
};

export function create(fields, { dir = STATE, now = () => new Date().toISOString(), by } = {}) {
  const title = clean(fields.title, 140);
  if (!title) throw new Error('a ticket needs a title');
  const kind = fields.kind ?? 'bug';
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  return withLock(dir, () => {
    const db = load(dir);
    const at = now();
    const t = {
      id: `KV-${String(db.next).padStart(3, '0')}`,
      title, kind,
      page: pageOf(fields.page),
      sizes: sizesOf(fields.sizes),
      focus: clean(fields.focus, 200),
      reporter: clean(fields.reporter, 60) ?? 'unknown',
      detail: clean(fields.detail, 2000),
      screenshot: clean(fields.screenshot, 400),
      status: 'new',
      created: at, updated: at,
      history: [{ at, by: by ?? 'kv-triager', status: 'new', note: 'opened' }],
    };
    db.next += 1;
    db.tickets.push(t);
    save(db, dir);
    return t;
  });
}

// set one or more fields; a status change is recorded in the ticket's history with who made it and why
export function update(id, patch, { dir = STATE, now = () => new Date().toISOString(), by = 'unknown', note } = {}) {
  const key = normalizeId(id);
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  return withLock(dir, () => {
    const db = load(dir);
    const t = db.tickets.find(x => x.id === key);
    if (!t) throw new Error(`no ticket ${key}`);
    const at = now();
    const before = t.status;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (k === 'sizes') t.sizes = sizesOf(v);
      else if (k === 'page') t.page = pageOf(v);
      else if (['id', 'created', 'history'].includes(k)) continue;
      else t[k] = typeof v === 'string' ? clean(v, k === 'detail' ? 2000 : 400) : v;
    }
    t.updated = at;
    if ((patch.status && patch.status !== before) || note) t.history.push({ at, by, status: t.status, note: clean(note, 300) });
    save(db, dir);
    return t;
  });
}

export function get(id, { dir = STATE } = {}) {
  const key = normalizeId(id);
  const t = load(dir).tickets.find(x => x.id === key);
  if (!t) throw new Error(`no ticket ${key}`);
  return t;
}

const LABEL = { new: 'New', 'needs-info': 'Waiting for an answer', building: 'Being fixed', checking: 'Being checked', passed: 'Checked, waiting for approval', failed: 'Check failed, being fixed', shipped: 'Shipped', closed: 'Closed' };

// the "Ticket board" room document: what is open, what is waiting for a person, what shipped lately
export function board({ dir = STATE, now = Date.now() } = {}) {
  const { tickets } = load(dir);
  const line = t => `- **${t.id}** ${t.title} · ${t.page} · reported by ${t.reporter}${t.pr ? ` · [pull request](${t.pr})` : ''}`;
  const group = (title, list) => (list.length ? [`### ${title}`, ...list.map(line), ''] : []);
  const open = tickets.filter(isOpen);
  const waiting = open.filter(t => t.status === 'passed' || t.status === 'needs-info');
  const working = open.filter(t => !waiting.includes(t));
  const week = 7 * 24 * 3600 * 1000;
  const shipped = tickets.filter(t => t.status === 'shipped' && now - Date.parse(t.updated) < week);
  const out = [
    '# Ticket board',
    `${open.length} open · ${waiting.length} waiting for a person · ${shipped.length} shipped in the last 7 days`,
    '',
    ...group('Waiting for a person', waiting.map(t => ({ ...t, title: `${t.title} (${LABEL[t.status]})` }))),
    ...group('In progress', working.map(t => ({ ...t, title: `${t.title} (${LABEL[t.status]})` }))),
    ...group('Shipped this week', shipped),
  ];
  if (!tickets.length) out.push('No tickets yet. Post feedback in this room and mention @kv-triager.');
  return out.join('\n').trim() + '\n';
}
