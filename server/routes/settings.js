/**
 * routes/settings.js - Admin-only application settings screen backend.
 *
 * Exposes a curated, flattened view of the most commonly edited connection
 * settings (MQTT, serial amp/rotator/tuner, FlexRadio, Home Assistant, general)
 * and writes changes back into config.json via a safe deep-merge so unrelated
 * nested fields (protocol strings, presets, meters, etc.) are preserved.
 */
const express = require('express');
const router = express.Router();
const storage = require('../storage');
const auth = require('../auth');

// All settings routes require an authenticated admin.
router.use(auth.requireAuth, auth.requireRole('admin'));

/** Build the flattened settings object the UI form binds to. */
function buildSettings(c) {
  const ser = (c.serial && c.serial.palstar_la1k_amp) || {};
  const rot = (c.serial && c.serial.erc_mini_rotator) || {};
  const tun = (c.serial && c.serial.palstar_hf_auto_tuner) || {};
  const tunAnt = (n, key) => (tun.antenna_rules && tun.antenna_rules[n] && tun.antenna_rules[n][key]) || '';
  const ha = c.home_assistant || {};
  const ent = ha.entities || {};

  return {
    general: {
      site_name: c.site && c.site.site_name,
      station_callsign: c.site && c.site.station_callsign,
      http_port: c.site && c.site.http_port,
      bind_address: c.site && c.site.bind_address,
      jwt_expiry: c.site && c.site.jwt_expiry
    },
    mqtt: {
      enabled: !!(c.mqtt && c.mqtt.enabled),
      broker: c.mqtt && c.mqtt.broker,
      port: c.mqtt && c.mqtt.port,
      username: c.mqtt && c.mqtt.username,
      password: c.mqtt && c.mqtt.password,
      client_id: c.mqtt && c.mqtt.client_id,
      topic_prefix: c.mqtt && c.mqtt.topic_prefix,
      publish_interval_sec: c.mqtt && c.mqtt.publish_interval_sec
    },
    serial: {
      enabled: !!ser.enabled,
      serial_port: ser.serial_port,
      baud_rate: ser.baud_rate,
      ant1_name: (ser.antenna_names && ser.antenna_names['1']) || '',
      ant2_name: (ser.antenna_names && ser.antenna_names['2']) || '',
      ant3_name: (ser.antenna_names && ser.antenna_names['3']) || ''
    },
    rotator: {
      enabled: !!rot.enabled,
      serial_port: rot.serial_port || 'COM5',
      baud_rate: rot.baud_rate || 9600
    },
    tuner: {
      enabled: !!tun.enabled,
      serial_port: tun.serial_port || 'COM4',
      baud_rate: tun.baud_rate || 4800,
      ant1_name: tunAnt('1', 'name'), ant1_mode: tunAnt('1', 'force_mode'),
      ant2_name: tunAnt('2', 'name'), ant2_mode: tunAnt('2', 'force_mode'),
      ant3_name: tunAnt('3', 'name'), ant3_mode: tunAnt('3', 'force_mode')
    },
    flexradio: {
      enabled: !!(c.flexradio && c.flexradio.enabled),
      host_mode: c.flexradio && c.flexradio.host_mode,
      host: c.flexradio && c.flexradio.host,
      discovery_port: c.flexradio && c.flexradio.discovery_port,
      tcp_port: (c.flexradio && c.flexradio.tcp_port) || 4992
    },
    home_assistant: {
      enabled: !!ha.enabled,
      base_url: ha.base_url || '',
      // Never send the real token to the browser; blank field = keep existing.
      // `token_set` lets the UI show whether a token is already configured.
      token: '',
      token_set: !!(ha.token && String(ha.token).trim()),
      topic_prefix: (c.mqtt && c.mqtt.topic_prefix) || '',
      power_supply_id: ent.power_supply && ent.power_supply.entity_id,
      amplifier_id: ent.amplifier && ent.amplifier.entity_id,
      radio_relay_id: ent.radio_relay && ent.radio_relay.entity_id,
      desk_light_1_id: ent.desk_light_1 && ent.desk_light_1.entity_id,
      desk_light_2_id: ent.desk_light_2 && ent.desk_light_2.entity_id
    }
  };
}

// Helpers for coercion / validation
const toInt = (v) => (v === '' || v === null || v === undefined ? undefined : parseInt(v, 10));
const isPort = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;

/**
 * Validate the incoming flattened settings payload.
 * Returns an array of error strings (empty = valid).
 */
function validate(s) {
  const errors = [];
  const ports = [
    ['General · Server port', s.general && toInt(s.general.http_port)],
    ['MQTT · Broker port', s.mqtt && toInt(s.mqtt.port)],
    ['FlexRadio · Discovery port', s.flexradio && toInt(s.flexradio.discovery_port)],
    ['FlexRadio · TCP port', s.flexradio && toInt(s.flexradio.tcp_port)]
  ];
  ports.forEach(([label, v]) => {
    if (v !== undefined && !isPort(v)) errors.push(`${label} must be a number between 1 and 65535.`);
  });

  if (s.mqtt && s.mqtt.enabled && !(s.mqtt.broker && String(s.mqtt.broker).trim())) {
    errors.push('MQTT · Broker address is required when MQTT is enabled.');
  }
  if (s.serial) {
    const b = toInt(s.serial.baud_rate);
    if (b !== undefined && (!Number.isInteger(b) || b <= 0)) errors.push('Amp Serial · Baud rate must be a positive number.');
  }
  if (s.rotator) {
    const b = toInt(s.rotator.baud_rate);
    if (b !== undefined && (!Number.isInteger(b) || b <= 0)) errors.push('Rotator · Baud rate must be a positive number.');
  }
  if (s.tuner) {
    const b = toInt(s.tuner.baud_rate);
    if (b !== undefined && (!Number.isInteger(b) || b <= 0)) errors.push('Tuner · Baud rate must be a positive number.');
  }
  return errors;
}

/** Apply the flattened settings back into the full config object (deep-merge). */
function applySettings(c, s) {
  c.site = c.site || {};
  c.mqtt = c.mqtt || {};
  c.serial = c.serial || {};
  c.serial.palstar_la1k_amp = c.serial.palstar_la1k_amp || {};
  c.serial.erc_mini_rotator = c.serial.erc_mini_rotator || {};
  c.serial.palstar_hf_auto_tuner = c.serial.palstar_hf_auto_tuner || {};
  c.flexradio = c.flexradio || {};
  c.home_assistant = c.home_assistant || {};
  c.home_assistant.entities = c.home_assistant.entities || {};

  const setIf = (obj, key, val) => { if (val !== undefined && val !== null && val !== '') obj[key] = val; };
  const setNum = (obj, key, val) => { const n = toInt(val); if (n !== undefined && !isNaN(n)) obj[key] = n; };
  const setEnt = (key, id) => {
    if (id !== undefined) {
      c.home_assistant.entities[key] = c.home_assistant.entities[key] || {};
      c.home_assistant.entities[key].entity_id = id;
    }
  };

  if (s.general) {
    setIf(c.site, 'site_name', s.general.site_name);
    setIf(c.site, 'station_callsign', s.general.station_callsign);
    setNum(c.site, 'http_port', s.general.http_port);
    setIf(c.site, 'bind_address', s.general.bind_address);
    setIf(c.site, 'jwt_expiry', s.general.jwt_expiry);
  }
  if (s.mqtt) {
    c.mqtt.enabled = !!s.mqtt.enabled;
    setIf(c.mqtt, 'broker', s.mqtt.broker);
    setNum(c.mqtt, 'port', s.mqtt.port);
    // username/password may legitimately be cleared -> allow empty strings
    if (s.mqtt.username !== undefined) c.mqtt.username = s.mqtt.username;
    if (s.mqtt.password !== undefined) c.mqtt.password = s.mqtt.password;
    setIf(c.mqtt, 'client_id', s.mqtt.client_id);
    setIf(c.mqtt, 'topic_prefix', s.mqtt.topic_prefix);
    setNum(c.mqtt, 'publish_interval_sec', s.mqtt.publish_interval_sec);
  }
  if (s.serial) {
    const amp = c.serial.palstar_la1k_amp;
    amp.enabled = !!s.serial.enabled;
    setIf(amp, 'serial_port', s.serial.serial_port);
    setNum(amp, 'baud_rate', s.serial.baud_rate);
    amp.antenna_names = amp.antenna_names || {};
    for (const n of ['1', '2', '3']) {
      const name = s.serial[`ant${n}_name`];
      if (name !== undefined) amp.antenna_names[n] = name;
    }
  }
  if (s.rotator) {
    c.serial.erc_mini_rotator.enabled = !!s.rotator.enabled;
    setIf(c.serial.erc_mini_rotator, 'serial_port', s.rotator.serial_port);
    setNum(c.serial.erc_mini_rotator, 'baud_rate', s.rotator.baud_rate);
  }
  if (s.tuner) {
    const tun = c.serial.palstar_hf_auto_tuner;
    tun.enabled = !!s.tuner.enabled;
    setIf(tun, 'serial_port', s.tuner.serial_port);
    setNum(tun, 'baud_rate', s.tuner.baud_rate);
    tun.antenna_rules = tun.antenna_rules || {};
    for (const n of ['1', '2', '3']) {
      tun.antenna_rules[n] = tun.antenna_rules[n] || {};
      const name = s.tuner[`ant${n}_name`];
      const mode = s.tuner[`ant${n}_mode`];
      if (name !== undefined && name !== '') tun.antenna_rules[n].name = name;
      if (mode === 'auto' || mode === 'bypass') tun.antenna_rules[n].force_mode = mode;
    }
  }
  if (s.flexradio) {
    c.flexradio.enabled = !!s.flexradio.enabled;
    setIf(c.flexradio, 'host_mode', s.flexradio.host_mode);
    if (s.flexradio.host !== undefined) c.flexradio.host = s.flexradio.host;
    setNum(c.flexradio, 'discovery_port', s.flexradio.discovery_port);
    setNum(c.flexradio, 'tcp_port', s.flexradio.tcp_port);
  }
  if (s.home_assistant) {
    c.home_assistant.enabled = !!s.home_assistant.enabled;
    if (s.home_assistant.base_url !== undefined) c.home_assistant.base_url = s.home_assistant.base_url;
    // Token may be left blank in the form to keep the existing one; only overwrite
    // when a non-empty value is provided so we never wipe a saved token by accident.
    if (s.home_assistant.token !== undefined && s.home_assistant.token !== '') {
      c.home_assistant.token = s.home_assistant.token;
    }
    if (s.home_assistant.topic_prefix !== undefined && s.home_assistant.topic_prefix !== '') {
      c.mqtt.topic_prefix = s.home_assistant.topic_prefix;
    }
    setEnt('power_supply', s.home_assistant.power_supply_id);
    setEnt('amplifier', s.home_assistant.amplifier_id);
    setEnt('radio_relay', s.home_assistant.radio_relay_id);
    setEnt('desk_light_1', s.home_assistant.desk_light_1_id);
    setEnt('desk_light_2', s.home_assistant.desk_light_2_id);
  }
  return c;
}

// GET /api/settings - flattened, editable settings
router.get('/', (req, res) => {
  res.json(buildSettings(storage.getConfig()));
});

// PUT /api/settings - validate, deep-merge, persist to config.json
router.put('/', (req, res) => {
  const incoming = req.body || {};
  const errors = validate(incoming);
  if (errors.length) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }
  const cfg = storage.getConfig();
  applySettings(cfg, incoming);
  storage.setConfig(cfg);
  res.json({
    ok: true,
    message: 'Settings saved to config.json. Restart the server to apply connection/hardware changes.',
    settings: buildSettings(cfg)
  });
});

module.exports = router;
