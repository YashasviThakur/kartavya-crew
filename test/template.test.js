// The Switch template, read without a YAML library: every placeholder is declared and used, every agent a
// room names exists, every agent has what Switch Console needs to create it, and the release gate holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = readFileSync(new URL('../switch/kartavya-crew.template.yaml', import.meta.url), 'utf8');
const blockOf = name => doc.slice(doc.indexOf(`  - name: ${name}\n`)).split(/\n {2}- name: /)[0];

test('every {placeholder} is a declared param and every param is used', () => {
  const declared = new Set([...doc.matchAll(/^ {2}([a-z_]+):\n {4}(?:type|label):/gm)].map(m => m[1]));
  const used = new Set([...doc.matchAll(/\{([a-z_]+)\}/g)].map(m => m[1]));
  assert.deepEqual([...used].filter(u => !declared.has(u)), []);
  assert.deepEqual([...declared].filter(d => !used.has(d)), []);
});

test('the five agents exist, each with provider, location, directory, addressing and a brief', () => {
  const agents = [...doc.slice(0, doc.indexOf('\ngroup:')).matchAll(/^ {2}- name: ([a-z0-9.-]+)$/gm)].map(m => m[1]);
  assert.deepEqual(agents, ['kv-triager', 'kv-builder', 'kv-checker', 'kv-shipper', 'kv-producer']);
  for (const a of agents) {
    const b = blockOf(a);
    for (const k of ['provider:', 'location:', 'directory:', 'addressing:', 'instructions: |']) assert.ok(b.includes(k), `${a} has ${k}`);
    assert.match(a, /^[a-z0-9][a-z0-9._-]*$/);
  }
  const rooms = [...doc.matchAll(/agents: \[([^\]]+)\]/g)].flatMap(m => m[1].split(',').map(s => s.trim()));
  for (const r of rooms) assert.ok(agents.includes(r), `room names ${r}`);
});

test('only the owner can address the release manager, and it releases only through ship.mjs', () => {
  const s = blockOf('kv-shipper');
  assert.match(s, /addressing: owner\n/);
  assert.match(s, /node \{crew\}\/tools\/ship\.mjs KV-### --approved-by/);
  assert.match(blockOf('kv-builder'), /Do not push/);
  assert.match(blockOf('kv-builder'), /addressing: owner-agents/);
});

test('the briefs carry the founder\'s rules', () => {
  const b = blockOf('kv-builder');
  for (const rule of ['Hindi', 'portal-bundles.css', 'Co-Authored-By', 'surveillance', 'Sample data', 'byte-identical']) assert.ok(b.includes(rule), `builder brief mentions ${rule}`);
  assert.match(doc, /- name: House rules/);
  assert.match(doc, /- name: How to report/);
});

test('three linked rooms, each with a kickoff that wakes its agents', () => {
  const rooms = [...doc.matchAll(/^ {2}- name: (kartavya-[a-z]+)$/gm)].map(m => m[1]);
  assert.deepEqual(rooms, ['kartavya-feedback', 'kartavya-ops', 'kartavya-studio']);
  assert.equal((doc.match(/^ {4}kickoff: \|/gm) ?? []).length, 3);
  assert.equal((doc.match(/^ {2}- \{ from: /gm) ?? []).length, 3);
});
