/**
 * routes/config.js - Read/update app configuration & expose UI-relevant bits.
 *
 * Full config (incl. secrets) is admin-only. A sanitized "public" config
 * (presets, antenna labels, meter ranges, site name) is available to all
 * authenticated users so the dashboard can render correctly.
 */
const express = require('express');
const router = express.Router();
const storage = require('../storage');
const auth = require('../auth');

// GET /api/config/public - safe subset for the dashboard UI
router.get('/public', auth.requireAuth, (req, res) => {
  const c = storage.getConfig();
  res.json({
    site_name: c.site && c.site.site_name,
    callsign: c.site && c.site.station_callsign,
    rotator_presets: (c.udp && c.udp.pst_rotator && c.udp.pst_rotator.presets) || [],
    tuner_antennas: (c.serial && c.serial.palstar_hf_auto_tuner && c.serial.palstar_hf_auto_tuner.antenna_rules) || {},
    flex_meters: (c.flexradio && c.flexradio.meters) || {},
    amp_integration: (c.flexradio && c.flexradio.amp_integration) || {}
  });
});

// GET /api/config - full config (admin only)
router.get('/', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  res.json(storage.getConfig());
});

// PUT /api/config - replace full config (admin only)
router.put('/', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ error: 'Invalid config payload' });
  }
  storage.setConfig(incoming);
  res.json({ ok: true, message: 'Configuration saved. Restart the server to apply hardware changes.' });
});

module.exports = router;
