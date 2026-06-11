/**
 * routes/devices.js - Device status (read) and control (write) endpoints.
 *
 * Read endpoints: any authenticated user (including view-only).
 * Control endpoints: admin + normal only (requireControl).
 */
const express = require('express');
const router = express.Router();
const auth = require('../auth');
const state = require('../services/state');

const serial = require('../services/serial');
const tuner = require('../services/tuner');
const rotator = require('../services/rotator');
const flex = require('../services/flexradio');
const mqtt = require('../services/mqtt');
const homeassistant = require('../services/homeassistant');

// ---- Status (read-only, all roles) ----
// GET /api/devices/status -> full snapshot
router.get('/status', auth.requireAuth, (req, res) => {
  res.json(state.get());
});

// ---- Control (admin + normal) ----
router.use(auth.requireAuth);

// FlexRadio
router.post('/flex/rfpower', auth.requireControl, (req, res) => {
  const v = flex.setRfPower(Number(req.body.value));
  res.json({ ok: true, rfpower: v });
});
router.post('/flex/apd', auth.requireControl, (req, res) => {
  const v = flex.toggleApd(!!req.body.enable);
  res.json({ ok: true, enable: v });
});

// Amplifier (Palstar LA-1K)
router.post('/amp/mode', auth.requireControl, (req, res) => {
  const mode = req.body.mode === 'operate' ? 'operate' : 'standby';
  serial.setMode(mode);
  // Apply RF power-limiting automation rule
  flex.applyAmpRfRule(mode);
  res.json({ ok: true, mode });
});
router.post('/amp/antenna', auth.requireControl, (req, res) => {
  const n = Math.max(1, Math.min(3, Number(req.body.antenna)));
  serial.selectAntenna(n);
  res.json({ ok: true, antenna: n });
});

// Rotator (ERC-Mini serial)
router.post('/rotator/azimuth', auth.requireControl, (req, res) => {
  const d = rotator.setAzimuth(Number(req.body.degrees));
  res.json({ ok: true, target: d });
});
router.post('/rotator/stop', auth.requireControl, (req, res) => {
  rotator.stopRotator();
  res.json({ ok: true });
});
// Manual jog — hold a direction ('cw' | 'ccw') or send 'stop'.
// Client should call this every ~800ms while the button is held; the server-side
// watchdog auto-stops the rotator if no heartbeat arrives within 2 s.
router.post('/rotator/jog', auth.requireControl, (req, res) => {
  const dir = String(req.body.dir || '').toLowerCase();
  console.log('[rotator/jog] dir=' + dir);
  if (dir === 'stop') {
    rotator.stopRotator();
    return res.json({ ok: true, moving: false });
  }
  if (dir !== 'cw' && dir !== 'ccw') {
    return res.status(400).json({ error: 'dir must be cw, ccw, or stop' });
  }
  rotator.jog(dir);
  res.json({ ok: true, moving: true, dir });
});

// Tuner (Palstar HF-Auto, direct serial)
router.post('/tuner/antenna', auth.requireControl, (req, res) => {
  const n = tuner.selectAntenna(Number(req.body.antenna));
  res.json({ ok: true, antenna: n });
});
router.post('/tuner/mode', auth.requireControl, (req, res) => {
  const mode = String(req.body.mode || '').toUpperCase();
  if (!['BYPASS', 'AUTO'].includes(mode)) {
    // MANUAL has no known serial command — front-panel only.
    return res.status(400).json({ error: 'mode must be BYPASS or AUTO' });
  }
  tuner.setMode(mode);
  res.json({ ok: true, mode });
});

// Power (Home Assistant smart plugs / relays).
// `stateKey` updates the UI state + MQTT status mirror; `haKey` is the configured
// Home Assistant entity that actually gets switched via the HA service API.
router.post('/power/:device', auth.requireControl, async (req, res) => {
  const map = {
    supply: { stateKey: 'powerSupply', haKey: 'power_supply' },
    radio: { stateKey: 'radioPower', haKey: 'radio_relay' },
    amp: { stateKey: 'ampPower', haKey: 'amplifier' }
  };
  const m = map[req.params.device];
  if (!m) return res.status(400).json({ error: 'Unknown power device' });
  const on = !!req.body.on;

  console.log(`[power] ${(req.user && req.user.sub) || 'user'} requested ${req.params.device} -> ${on ? 'ON' : 'OFF'}`);

  // Mirror the requested status to MQTT (for HA dashboards). We intentionally do
  // NOT optimistically flip the UI state here - setSwitch() reads the *actual*
  // state back from HA and broadcasts that, so the UI always reflects reality.
  mqtt.publishValue(m.stateKey, on);

  // Command the device through Home Assistant and confirm the resulting state.
  const ha = await homeassistant.setSwitch(m.haKey, on);

  if (!ha.ok && ha.error !== 'disabled') {
    // Command failed at HA. Re-read the real state so the UI is not left guessing.
    const actual = state.get().power[m.stateKey];
    return res.status(502).json({
      ok: false,
      [m.stateKey]: actual,
      error: `Home Assistant command failed: ${ha.error}`,
      ha
    });
  }

  // `confirmed` is the authoritative state HA reported after the command.
  // Fall back to the requested value if confirmation was unavailable
  // (e.g. HA disabled in config / dev mode).
  const confirmed = (typeof ha.confirmed === 'boolean') ? ha.confirmed : on;
  if (ha.error === 'disabled') {
    // No HA - keep legacy behavior: reflect the requested value locally.
    state.update('power', { [m.stateKey]: on });
  }
  console.log(`[power] ${req.params.device} result -> requested=${on} confirmed=${confirmed}`);
  res.json({ ok: true, [m.stateKey]: confirmed, requested: on, confirmed, ha });
});

module.exports = router;
