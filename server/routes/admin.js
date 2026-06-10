/**
 * routes/admin.js - Internal admin endpoints for remote diagnostics and control.
 *
 * ALL routes here are already gated by the lanOnly middleware mounted in index.js.
 * The /restart route additionally requires a valid admin JWT so a stray LAN request
 * cannot accidentally cycle the server.
 *
 * Endpoints:
 *   GET  /api/admin/health   - liveness check (no auth required)
 *   GET  /api/admin/logs     - recent log lines from the in-memory buffer (no auth)
 *   GET  /api/admin/status   - uptime, memory, device state snapshot (no auth)
 *   POST /api/admin/restart  - graceful process exit (admin JWT required)
 */
const express = require('express');
const router = express.Router();
const auth = require('../auth');
const logbuffer = require('../services/logbuffer');
const state = require('../services/state');

// GET /api/admin/health
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    time: Date.now(),
    node: process.version,
    pid: process.pid
  });
});

// GET /api/admin/logs?lines=100
router.get('/logs', (req, res) => {
  const n = Math.min(500, Math.max(1, parseInt(req.query.lines) || 100));
  res.json({ lines: logbuffer.tail(n), count: n });
});

// GET /api/admin/status
router.get('/status', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    uptime: Math.round(process.uptime()),
    pid: process.pid,
    memory: {
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + ' MB',
      rss: Math.round(mem.rss / 1024 / 1024) + ' MB'
    },
    devices: state.get()
  });
});

// POST /api/admin/restart  (admin JWT required)
// The process exits cleanly; the process manager (Task Scheduler restart-on-failure
// or NSSM) is responsible for bringing it back up.
router.post('/restart', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  res.json({ ok: true, message: 'Process exiting — waiting for process manager to restart.' });
  setTimeout(() => {
    console.log('[admin] restart requested via API');
    process.exit(0);
  }, 300);
});

module.exports = router;
