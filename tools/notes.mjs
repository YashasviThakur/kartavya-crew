#!/usr/bin/env node
// What shipped lately, as raw material for kv-shipper's plain-English release note.
//   node tools/notes.mjs --since 7      tickets shipped in the last 7 days (default)
import { parseArgs } from 'node:util';
import { load } from './lib/store.mjs';
import { isMain } from './lib/cli.mjs';

export function shippedSince(tickets, days, now = Date.now()) {
  const from = now - days * 86400000;
  return tickets
    .filter(t => t.status === 'shipped')
    .map(t => ({ t, at: Date.parse(t.history.findLast?.(h => h.status === 'shipped')?.at ?? t.updated) }))
    .filter(x => x.at >= from)
    .sort((a, b) => a.at - b.at)
    .map(x => x.t);
}

export function notesMaterial(tickets, days) {
  const list = shippedSince(tickets, days);
  if (!list.length) return `Nothing shipped in the last ${days} days.`;
  const byPage = new Map();
  for (const t of list) byPage.set(t.page, [...(byPage.get(t.page) ?? []), t]);
  const out = [`${list.length} change${list.length > 1 ? 's' : ''} shipped in the last ${days} days:`, ''];
  for (const [page, ts] of byPage) {
    out.push(`Page ${page}:`);
    for (const t of ts) out.push(`- ${t.id} (${t.kind}) ${t.title}. Reported by ${t.reporter}.${t.detail ? ` They said: "${t.detail.slice(0, 200)}"` : ''}${t.pr ? ` ${t.pr}` : ''}`);
    out.push('');
  }
  out.push('Write the note for the founders: what changed for families visiting the site, in plain words. No file names, no jargon.');
  return out.join('\n');
}

if (isMain(import.meta.url)) {
  const { values: v } = parseArgs({ options: { since: { type: 'string', default: '7' } } });
  console.log(notesMaterial(load().tickets, Number(v.since) || 7));
}
