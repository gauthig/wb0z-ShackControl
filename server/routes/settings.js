/**
 * routes/settings.js - Admin-only application settings screen backend.
 *
 * Exposes a curated, flattened view of the most commonly edited connection
 * settings (MQTT, serial, UDP rotator/tuner, FlexRadio, Home Assistant, general)
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
  const rot = (c.udp && c.udp.pst_rotator) || {};
  const tun = (c.udp && c.udp.palstar_hf_auto_tuner) || {};
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
      baud_rate: ser.baud_rate
    },
    rotator: {
      enabled: !!rot.enabled,
      send_address: rot.send_address,
      send_port: rot.send_port,
      listen_port: rot.listen_port
    },
    tuner: {
      enabled: !!tun.enabled,
      send_address: tun.send_address,
      send_port: tun.send_port,
      listen_port: tun.listen_port
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
    ['Rotator · Command port', s.rotator && toInt(s.rotator.send_port)],
    ['Rotator · Status port', s.rotator && toInt(s.rotator.listen_port)],
    ['Tuner · Command port', s.tuner && toInt(s.tuner.send_port)],
    ['Tuner · Status port', s.tuner && toInt(s.tuner.listen_port)],
    ['FlexRadio · Discovery port', s.flexradio && toInt(s.flexradio.discovery_port)],
    ['FlexRadio · TCP port', s.flexradio && toInt(s.flexradio.tcp_port)]
  ];
  ports.forEach(([label, v]) => {
    if (v !== undefined && !isPort(v)) errors.push(`${label} must be a number between 1 and 65535.`);
  });

  const ip = /^(\d{1,3})(\.\d{1,3}){3}$/;
  [['Rotator · IP address', s.rotator && s.rotator.send_address],
   ['Tuner · IP address', s.tuner && s.tuner.send_address]].forEach(([label, v]) => {
    if (v && !ip.test(v)) errors.push(`${label} must be a valid IPv4 address.`);
  });

  if (s.mqtt && s.mqtt.enabled && !(s.mqtt.broker && String(s.mqtt.broker).trim())) {
    errors.push('MQTT · Broker address is required when MQTT is enabled.');
  }
  if (s.serial) {
    const b = toInt(s.serial.baud_rate);
    if (b !== undefined && (!Number.isInteger(b) || b <= 0)) errors.push('Serial · Baud rate must be a positive number.');
  }
  return errors;
}

/** Apply the flattened settings back into the full config object (deep-merge). */
function applySettings(c, s) {
  c.site = c.site || {};
  c.mqtt = c.mqtt || {};
  c.serial = c.serial || {}; c.serial.palstar_la1k_amp = c.serial.palstar_la1k_amp || {};
  c.udp = c.udp || {};
  c.udp.pst_rotator = c.udp.pst_rotator || {};
  c.udp.palstar_hf_auto_tuner = c.udp.palstar_hf_auto_tuner || {};
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
    c.serial.palstar_la1k_amp.enabled = !!s.serial.enabled;
    setIf(c.serial.palstar_la1k_amp, 'serial_port', s.serial.serial_port);
    setNum(c.serial.palstar_la1k_amp, 'baud_rate', s.serial.baud_rate);
  }
  if (s.rotator) {
    c.udp.pst_rotator.enabled = !!s.rotator.enabled;
    setIf(c.udp.pst_rotator, 'send_address', s.rotator.send_address);
    setNum(c.udp.pst_rotator, 'send_port', s.rotator.send_port);
    setNum(c.udp.pst_rotator, 'listen_port', s.rotator.listen_port);
  }
  if (s.tuner) {
    c.udp.palstar_hf_auto_tuner.enabled = !!s.tuner.enabled;
    setIf(c.udp.palstar_hf_auto_tuner, 'send_address', s.tuner.send_address);
    setNum(c.udp.palstar_hf_auto_tuner, 'send_port', s.tuner.send_port);
    setNum(c.udp.palstar_hf_auto_tuner, 'listen_port', s.tuner.listen_port);
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
