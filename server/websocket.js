/**
 * websocket.js - Real-time push of device state to browsers.
 *
 * Clients connect to /ws?token=<JWT>. The handshake validates the token.
 * On connect, the full state snapshot is sent; afterwards, incremental
 * change events are broadcast as they happen.
 */
const { WebSocketServer } = require('ws');
const url = require('url');
const auth = require('./auth');
const state = require('./services/state');

let wss = null;

function init(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const { query } = url.parse(req.url, true);
    const user = auth.verifyToken(query.token);
    if (!user) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    ws.user = user;

    // Send initial full snapshot
    ws.send(JSON.stringify({ type: 'snapshot', data: state.get() }));

    ws.on('message', (msg) => {
      // Clients may send a ping; reply pong. Control is via REST, not WS.
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
      } catch { /* ignore */ }
    });
  });

  // Broadcast state changes to all connected clients
  state.onChange(({ section, partial }) => {
    broadcast({ type: 'update', section, partial });
  });

  // Periodic heartbeat / time sync
  setInterval(() => broadcast({ type: 'heartbeat', t: Date.now() }), 15000);

  console.log('[ws] WebSocket server ready on /ws');
}

function broadcast(obj) {
  if (!wss) return;
  const data = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(data);
  });
}

module.exports = { init, broadcast };
