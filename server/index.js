/**
 * index.js - Main application entry point.
 *
 * - Bootstraps storage + default admin (setup.run()).
 * - Starts the Express HTTP server (REST API + static frontend).
 * - Attaches the WebSocket server for real-time updates.
 * - Starts all device services (serial / udp / mqtt / flexradio).
 *
 * Designed to run on Windows 11 alongside (or instead of) Node-RED.
 */
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const storage = require('./storage');
const setup = require('./setup');
const websocket = require('./websocket');
const logbuffer = require('./services/logbuffer');

// Device services
const serial = require('./services/serial');
const tuner = require('./services/tuner');
const rotator = require('./services/rotator');
const mqtt = require('./services/mqtt');
const flex = require('./services/flexradio');
const homeassistant = require('./services/homeassistant');

// Routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const deviceRoutes = require('./routes/devices');
const configRoutes = require('./routes/config');
const themeRoutes = require('./routes/themes');
const settingsRoutes = require('./routes/settings');
const adminRoutes = require('./routes/admin');
const lanOnly = require('./middleware/lan-only');

// 1) Bootstrap: capture logs first, then init data files / admin user
logbuffer.init();
setup.run();

const cfg = storage.getConfig();
const PORT = (cfg.site && cfg.site.http_port) || 3000;
const HOST = (cfg.site && cfg.site.bind_address) || '0.0.0.0';

// 2) Express app
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));

// API
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/config', configRoutes);
app.use('/api/themes', themeRoutes);
app.use('/api/settings', settingsRoutes);

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// Admin endpoints — LAN-only IP gate applied first
app.use('/api/admin', lanOnly, adminRoutes);

// Static frontend
const clientDir = path.join(__dirname, '..', 'client');
app.use(express.static(clientDir));
// SPA-ish fallback for the dashboard
app.get('/dashboard', (req, res) => res.sendFile(path.join(clientDir, 'dashboard.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(clientDir, 'settings.html')));

// 3) HTTP + WebSocket
const server = http.createServer(app);
websocket.init(server);

// 4) Start device services
function startServices() {
  const c = storage.getConfig();
  try { serial.start(c); } catch (e) { console.error('[serial] start error:', e.message); }
  try { tuner.start(c); } catch (e) { console.error('[tuner] start error:', e.message); }
  try { rotator.start(c); } catch (e) { console.error('[rotator] start error:', e.message); }
  try { mqtt.start(c); } catch (e) { console.error('[mqtt] start error:', e.message); }
  try { flex.start(c); } catch (e) { console.error('[flex] start error:', e.message); }
  try { homeassistant.start(c); } catch (e) { console.error('[ha] start error:', e.message); }
}
startServices();

server.listen(PORT, HOST, () => {
  console.log('========================================================');
  console.log(`  ${(cfg.site && cfg.site.site_name) || 'Ham Radio Web App'}`);
  console.log(`  HTTP + WebSocket listening on http://${HOST}:${PORT}`);
  console.log(`  Open http://localhost:${PORT} in your browser.`);
  console.log('========================================================');
});

// Graceful shutdown
function shutdown() {
  console.log('\n[server] shutting down...');
  try { serial.stop(); } catch {}
  try { tuner.stop(); } catch {}
  try { rotator.stop(); } catch {}
  try { mqtt.stop(); } catch {}
  try { flex.stop(); } catch {}
  try { homeassistant.stop(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
