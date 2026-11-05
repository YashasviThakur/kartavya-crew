#!/usr/bin/env node
// Register kv-watchdog with your Switch server, once.
//   node watchdog/register.mjs [--api http://localhost:<port>]   (asks for the registration key)
// --api is the agent bridge's base URL (GET /health on it answers 200; it is usually not the Gateway URL).
// The registration key is created in the Gateway, API Keys page, type "registration".
// Saves the agent's own API key to state/watchdog.json (git-ignored). Run it again with --overwrite to replace.
import { parseArgs } from 'node:util';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { STATE } from '../tools/config.mjs';
import { register, probe, SwitchAgent } from './switch.mjs';
import { CONFIG } from './watchdog.mjs';
import { NAME } from './logic.mjs';

// Asks for the key when it isn't given, so it never has to sit in a command line or the shell's history.
async function askKey() {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const key = (await rl.question('Paste the registration key from the Gateway (API Keys), then press Enter: ')).trim();
  rl.close();
  return key;
}

const { values: v } = parseArgs({ options: { api: { type: 'string', default: 'http://localhost:51797' }, key: { type: 'string' }, overwrite: { type: 'boolean' } } });
try {
  v.key ??= process.env.SWITCH_REGISTRATION_KEY || await askKey();
  if (!v.key) throw new Error('no key given: create one in the Gateway, API Keys page, type "registration"');
  if (existsSync(CONFIG) && !v.overwrite) throw new Error(`${CONFIG} already exists. Use --overwrite to register again (the old key stops working).`);
  const status = await probe(v.api);
  if (status !== 200) throw new Error(`${v.api}/health answered ${status || 'nothing'}: that is not the agent bridge. Find its URL in Switch Console (Settings, Servers).`);
  const r = await register(v.api, v.key, { name: NAME, displayName: 'Kartavya watchdog', description: 'Checks thekartavya.com every few hours and reports problems' });
  const agent = new SwitchAgent({ api: v.api, agentId: r.id, apiKey: r.api_key });
  // read-only work, so anyone in its rooms may ask it to check
  try { await agent.op('update_agent_detail', { agent_id: r.id, addressing: 'anyone' }, { bindRoom: false }); } catch (e) { console.error(`could not open it to the room (${e.message}); it will answer only you`); }
  mkdirSync(STATE, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify({ api: v.api, agentId: r.id, apiKey: r.api_key, connectionId: randomUUID() }, null, 2));
  console.log(`Registered ${NAME} (${r.id}). Saved its key to ${CONFIG}.\nNext: in kartavya-ops type  !invite-agent @${NAME}  then run  node watchdog/watchdog.mjs`);
} catch (e) { console.error(e.message); process.exit(1); }
