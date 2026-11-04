#!/usr/bin/env node
// The agents' ticket command.
//   node tools/ticket.mjs new --title "Plans text cut off on phones" --kind bug --page / --sizes phone --reporter gurinder --detail "..."
//   node tools/ticket.mjs set KV-001 --status building --branch crew/kv-001-plans --by kv-builder --note "..."
//   node tools/ticket.mjs show KV-001        (JSON)
//   node tools/ticket.mjs list [--all]       (one line each; open tickets unless --all)
//   node tools/ticket.mjs board              (the "Ticket board" room document, as Markdown)
import { parseArgs } from 'node:util';
import { create, update, get, load, board, isOpen } from './lib/store.mjs';
import { isMain } from './lib/cli.mjs';

const FIELDS = ['title', 'kind', 'page', 'sizes', 'focus', 'reporter', 'detail', 'screenshot', 'status', 'branch', 'sha', 'report', 'pr', 'merged'];
const options = Object.fromEntries([...FIELDS, 'by', 'note'].map(k => [k, { type: 'string' }]));
options.all = { type: 'boolean' };
options.json = { type: 'boolean' };

export function main(argv, out = console.log) {
  const { values: v, positionals: [cmd, id] } = parseArgs({ args: argv, options, allowPositionals: true });
  const pick = () => Object.fromEntries(FIELDS.filter(k => v[k] !== undefined).map(k => [k, v[k]]));
  switch (cmd) {
    case 'new': {
      const t = create(pick(), { by: v.by });
      out(v.json ? JSON.stringify(t, null, 2) : `${t.id} opened: ${t.title} · ${t.page} · ${t.sizes.join(', ')}`);
      return t;
    }
    case 'set': {
      const { by, note } = v;
      const t = update(id, pick(), { by: by ?? 'unknown', note });
      out(v.json ? JSON.stringify(t, null, 2) : `${t.id} is now ${t.status}${t.branch ? ` · ${t.branch}` : ''}`);
      return t;
    }
    case 'show': { const t = get(id); out(JSON.stringify(t, null, 2)); return t; }
    case 'list': {
      const list = load().tickets.filter(t => v.all || isOpen(t));
      out(list.length ? list.map(t => `${t.id}  ${t.status.padEnd(10)}  ${t.page.padEnd(16)}  ${t.title}`).join('\n') : 'No open tickets.');
      return list;
    }
    case 'board': { const b = board(); out(b); return b; }
    default:
      throw new Error('usage: ticket.mjs new|set|show|list|board  (see the top of tools/ticket.mjs)');
  }
}

if (isMain(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}
