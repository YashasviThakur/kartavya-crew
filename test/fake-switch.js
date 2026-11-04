// A pretend Switch agent bridge for tests: the HTTP routes the watchdog calls, and a WebSocket that sends
// connection_state, pings and events the way the agent protocol describes. Tiny hand-written WebSocket.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const frame = text => {
  const p = Buffer.from(text);
  const head = p.length < 126 ? Buffer.from([0x81, p.length]) : p.length < 65536 ? Buffer.from([0x81, 126, p.length >> 8, p.length & 255]) : null;
  return Buffer.concat([head, p]);
};
function* readFrames(buf) {
  let i = 0;
  while (i + 2 <= buf.length) {
    const op = buf[i] & 15; let len = buf[i + 1] & 127; let j = i + 2;
    if (len === 126) { len = buf.readUInt16BE(j); j += 2; }
    const mask = buf.subarray(j, j + 4); j += 4;
    if (j + len > buf.length) return;
    const data = Buffer.from(buf.subarray(j, j + len)).map((b, k) => b ^ mask[k % 4]);
    yield { op, text: data.toString() };
    i = j + len;
  }
}

export function fakeSwitch({ apiKey = 'agent-key', agentId = 'a-1', rooms = ['room-ops'] } = {}) {
  const posts = [], pongs = [], calls = [];
  let sock = null;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : {};
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, json, conn: req.headers['x-switch-connection-id'] });
    const send = (s, o) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/health') return send(200, { ok: true });
    if (req.method === 'POST' && req.url === '/agents') return req.headers.authorization === 'Bearer reg-key' ? send(200, { id: agentId, api_key: apiKey }) : send(401, { detail: 'bad key' });
    if (req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { detail: 'unauthorized' });
    if (req.url === `/agents/${agentId}/ops`) return send(200, { operations: { post_message: { description: 'post', input_schema: { properties: { content: {}, thread_id: {} } } }, get_room_detail: { input_schema: { properties: { room_id: {} } } } } });
    if (req.url === `/agents/${agentId}/ops/get_room_detail`) return send(200, { result: { id: json.room_id, name: json.room_id === 'room-ops' ? 'kartavya-ops' : 'other' } });
    if (req.url === `/agents/${agentId}/ops/post_message`) { posts.push({ via: 'op', ...json }); return send(200, { result: { ok: true } }); }
    if (req.url === `/agents/${agentId}/ops/update_agent_detail`) return send(200, { result: { ok: true } });
    if (req.url === `/agents/${agentId}/message`) { posts.push({ via: 'message', ...json }); return send(200, { ok: true }); }
    send(404, { detail: 'no route' });
  });
  server.on('upgrade', (req, socket) => {
    const ok = req.headers.authorization === `Bearer ${apiKey}` && new URL(req.url, 'http://x').searchParams.get('connection_id');
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (!ok) { socket.end(Buffer.from([0x88, 2, 0x11, 0x31])); return; } // close 4401
    sock = socket;
    let pending = Buffer.alloc(0);
    socket.on('data', d => {
      pending = Buffer.concat([pending, d]);
      for (const f of readFrames(pending)) if (f.op === 1) pongs.push(JSON.parse(f.text));
      pending = Buffer.alloc(0);
    });
    socket.on('error', () => {});
    socket.write(frame(JSON.stringify({ type: 'connection_state', connection_id: 'c', agent_id: agentId, generation: 7, rooms, cursor: 0, heartbeat_interval_seconds: 2 })));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, posts, pongs, calls,
    send: obj => sock?.write(frame(JSON.stringify(obj))),
    close: () => { try { sock?.destroy(); } catch {} server.close(); },
  })));
}
