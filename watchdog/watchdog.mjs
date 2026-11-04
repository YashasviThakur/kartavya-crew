#!/usr/bin/env node
// kv-watchdog: an always-on Switch agent that watches thekartavya.com.
//   node watchdog/watchdog.mjs                 run (after watchdog/register.mjs)
//   node watchdog/watchdog.mjs --every 360     minutes between checks (default 360 = every 6 hours)
// It posts in the room named kartavya-ops (or its first room) when the site's health changes, once each
// morning, and whenever someone writes "@kv-watchdog check". New critical problems go to @kv-triager.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { STATE } from '../tools/config.mjs';
import { isMain } from '../tools/lib/cli.mjs';
import { checkHealth, formatHealth } from '../tools/health.mjs';
import { SwitchAgent } from './switch.mjs';
import { NAME, HELP, parseCommand, diffHealth, incidentMessage, changeMessage, dailyDue } from './logic.mjs';

export const CONFIG = join(STATE, 'watchdog.json');
const log = m => console.error(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

export function loadConfig(file = CONFIG) {
  if (!existsSync(file)) throw new Error(`no ${file}: run  node watchdog/register.mjs --api <bridge URL> --key <registration key>  first`);
  return JSON.parse(readFileSync(file, 'utf8'));
}
function saveConfig(cfg, file = CONFIG) {
  mkdirSync(STATE, { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(cfg, null, 2));
  renameSync(`${file}.tmp`, file);
}

const roomName = r => r?.name ?? r?.room_name ?? r?.display_name ?? '';
async function findHome(agent, cfg) {
  if (cfg.homeRoom && agent.rooms.includes(cfg.homeRoom)) return cfg.homeRoom;
  for (const id of agent.rooms) {
    try {
      const d = await agent.op('get_room_detail', { room_id: id }, { bindRoom: false });
      if (/kartavya-ops|(^|-)ops$/i.test(roomName(d) || roomName(d?.room))) return id;
    } catch {}
  }
  return agent.rooms[0] ?? null;
}

export async function startWatchdog({ cfg, everyMin = 360, check = checkHealth, save = saveConfig, Agent = SwitchAgent, now = () => new Date() }) {
  const agent = new Agent({ ...cfg, log });
  try { agent.opsCatalog = await agent.operations(); } catch (e) { log(`could not read the operations list: ${e.message}`); agent.opsCatalog = {}; }
  let home = null, busy = false, timer = null;
  let last = cfg.last ?? null;

  async function runCheck(reason) {
    if (busy) return null;
    busy = true;
    try {
      const h = await check();
      const d = diffHealth(last, h);
      const day = dailyDue(cfg.lastDaily, now());
      if (home) {
        if (d.changed) await agent.post(home, changeMessage(h, d));
        else if (day && reason === 'timer') await agent.post(home, `Good morning. Daily check:\n${formatHealth(h)}`);
        if (d.broke.length) await agent.post(home, incidentMessage(h, d.broke));
      }
      if (day) cfg.lastDaily = day;
      last = { ok: h.ok, base: h.base, at: h.at, checks: h.checks };
      cfg.last = last;
      save(cfg);
      return h;
    } finally { busy = false; }
  }

  const onEvent = async (kind, ev) => {
    if (kind !== 'message' || !ev.payload?.addressed) return;
    const room = ev.room_id;
    const thread = ev.payload.thread_id ?? ev.payload.message_id;
    const cmd = parseCommand(ev.payload.body);
    if (cmd === 'help') return agent.post(room, HELP, { threadId: thread });
    if (cmd === 'last') return agent.post(room, last ? formatHealth(last) : 'No result yet. Say `check`.', { threadId: thread });
    await agent.post(room, 'Checking thekartavya.com now…', { threadId: thread });
    const h = await runCheck('asked');
    if (h) await agent.post(room, formatHealth(h), { threadId: thread });
  };

  const onState = async () => {
    home = await findHome(agent, cfg);
    if (!home) { log(`${NAME} is in no room yet. In kartavya-ops type: !invite-agent @${NAME}`); return; }
    log(`on duty in ${agent.rooms.length} room(s); posting in ${home}`);
    if (!timer) {
      await runCheck('start');
      timer = setInterval(() => runCheck('timer').catch(e => log(`check failed: ${e.message}`)), everyMin * 60_000);
      // the morning summary should not wait up to six hours
      setInterval(() => { if (dailyDue(cfg.lastDaily, now())) runCheck('timer').catch(() => {}); }, 15 * 60_000).unref?.();
    }
  };
  const onCursor = c => { cfg.cursor = c; cfg.generation = agent.generation; };
  const running = agent.run({ onEvent, onState, onCursor });
  return { agent, running, runCheck, stop: () => { clearInterval(timer); agent.stop(); } };
}

if (isMain(import.meta.url)) {
  const { values: v } = parseArgs({ options: { every: { type: 'string', default: '360' } } });
  try {
    const cfg = loadConfig();
    log(`${NAME} starting (checks every ${v.every} minutes)`);
    const w = await startWatchdog({ cfg, everyMin: Math.max(5, Number(v.every) || 360) });
    process.on('SIGINT', () => { w.stop(); process.exit(0); });
    await w.running;
  } catch (e) { log(e.message); process.exit(1); }
}
