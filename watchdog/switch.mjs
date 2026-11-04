// A Switch agent client, written to the agent protocol (docs.switchagents.ai, "The agent protocol" and
// "Agent connection"): register once, then one WebSocket for events with ping/pong liveness and resume,
// and HTTP for everything the agent does. Node's own fetch and WebSocket; no packages.
import { randomUUID } from 'node:crypto';

export class SwitchError extends Error {
  constructor(status, detail) { super(`Switch answered ${status}: ${detail}`); this.status = status; }
}

async function call(base, path, { method = 'GET', token, body, headers = {} } = {}) {
  const r = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { text }; }
  if (!r.ok) throw new SwitchError(r.status, json.detail ? JSON.stringify(json.detail) : text.slice(0, 300));
  return json;
}

// GET /health is public: a healthy answer means this is the agent bridge's base URL
export async function probe(base) {
  try { const r = await fetch(`${base.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(5000) }); return r.status; } catch { return 0; }
}

// POST /agents with a registration key, once. The API key it returns is shown only once.
export async function register(base, registrationKey, { name, displayName, description }) {
  return call(base, '/agents', {
    method: 'POST', token: registrationKey,
    body: {
      name, display_name: displayName, description, connector_type: 'kartavya-watchdog',
      integration_profile: { connection_model: 'always_on', message_exchange: true, pre_invocation_mediation: [], post_invocation_mediation: [], event_reporting: [] },
    },
  });
}

export class SwitchAgent {
  constructor({ api, agentId, apiKey, connectionId = randomUUID(), cursor = null, generation = null, log = () => {} }) {
    Object.assign(this, { api: api.replace(/\/$/, ''), agentId, apiKey, connectionId, cursor, generation, log });
    this.rooms = [];
    this.stopped = false;
    this.ws = null;
  }

  request(path, opts = {}) { return call(this.api, path, { token: this.apiKey, ...opts }); }

  async operations() { return (await this.request(`/agents/${this.agentId}/ops`)).operations ?? {}; }

  // POST /agents/{id}/ops/{name}, arguments unwrapped in the body
  async op(name, args = {}, { bindRoom = true } = {}) {
    const r = await this.request(`/agents/${this.agentId}/ops/${name}`, { method: 'POST', body: args, headers: bindRoom ? { 'x-switch-connection-id': this.connectionId } : {} });
    return r.result;
  }

  // post into a room; in a thread when the server's post_message takes one, else at the room root
  async post(roomId, content, { threadId } = {}) {
    if (threadId && this.opsCatalog?.post_message) {
      const props = Object.keys(this.opsCatalog.post_message.input_schema?.properties ?? {});
      if (props.includes('thread_id')) {
        const args = { content, thread_id: threadId };
        if (props.includes('room_id')) args.room_id = roomId;
        try { return await this.op('post_message', args); } catch (e) { this.log(`threaded post failed (${e.message}); posting at the room root`); }
      }
    }
    return this.request(`/agents/${this.agentId}/message`, { method: 'POST', body: { room_id: roomId, content } });
  }

  socketUrl() {
    const u = new URL(`${this.api}/agents/${this.agentId}/connection/ws`);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('connection_id', this.connectionId);
    u.searchParams.set('scope', 'all');      // every room this agent is in
    u.searchParams.set('filter', 'all');     // everything; we act only on messages that address us
    u.searchParams.set('client', 'kartavya-watchdog');
    u.searchParams.set('client_version', '0.1.0');
    if (this.cursor !== null) u.searchParams.set('start_from', String(this.cursor));
    if (this.generation !== null) u.searchParams.set('expected_generation', String(this.generation));
    return u.toString();
  }

  // Keep one connection open until stop(). onEvent gets domain events (message, command, room_join).
  async run({ onEvent, onState = () => {}, onCursor = () => {} }) {
    let wait = 1000;
    while (!this.stopped) {
      const end = await new Promise(resolve => {
        const ws = new WebSocket(this.socketUrl(), { headers: { authorization: `Bearer ${this.apiKey}` } });
        this.ws = ws;
        let finished = false;
        const finish = why => { if (!finished) { finished = true; resolve(why); } };
        ws.onmessage = async e => {
          let f; try { f = JSON.parse(e.data); } catch { return; }
          // answer pings first, before any work
          if (f.type === 'ping' || f.event === 'ping') { ws.send(JSON.stringify({ type: 'pong', cursor: this.cursor ?? 0 })); return; }
          const kind = f.type ?? f.event;
          if (kind === 'connection_state') {
            const s = f.data ?? f;
            this.generation = s.generation ?? this.generation;
            this.rooms = s.rooms ?? [];
            if (s.cursor !== undefined && s.cursor !== null) this.cursor = Math.max(this.cursor ?? 0, Number(s.cursor));
            wait = 1000;
            onState(s);
            return;
          }
          if (kind === 'subscription_changed') { this.rooms = (f.data ?? f).rooms ?? this.rooms; return; }
          if (kind === 'evicted') { const code = (f.data ?? f).code; finish(code === 'taken_over' ? 'taken_over' : code === 'closed' ? 'closed' : 'retry'); return; }
          if (kind === 'refused') { finish('closed'); this.log(`refused: ${JSON.stringify(f.data ?? f)}`); return; }
          if (kind === 'gap') { const g = f.data ?? f; if (g.resumed_at !== undefined) this.cursor = Number(g.resumed_at); return; }
          if (f.event && f.data && f.id !== undefined) {
            this.cursor = Math.max(this.cursor ?? 0, Number(f.id));
            onCursor(this.cursor);
            try { await onEvent(f.event, f.data); } catch (err) { this.log(`event handler failed: ${err.message}`); }
          }
        };
        ws.onclose = ev => finish(ev.code === 4401 ? 'unauthorized' : ev.code === 4409 ? 'conflict' : 'retry');
        ws.onerror = () => {};
      });
      this.ws = null;
      if (this.stopped) break;
      if (end === 'taken_over') { this.log('another copy of the watchdog took over this connection; stopping'); break; }
      if (end === 'unauthorized') throw new Error('Switch refused the API key: register the watchdog again');
      if (end === 'closed') throw new Error('Switch closed the connection for good (agent deleted or moved)');
      this.log(`connection dropped (${end}); reconnecting in ${Math.round(wait / 1000)} s`);
      await new Promise(r => setTimeout(r, wait));
      wait = Math.min(wait * 2, 60000);
    }
  }

  stop() { this.stopped = true; try { this.ws?.close(1000); } catch {} }
}
