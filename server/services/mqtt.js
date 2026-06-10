/**
 * mqtt.js - Bridge to Home Assistant's Mosquitto broker (default 192.168.1.54:1883).
 *
 * Uses the `mqtt` npm package (loaded lazily). Publishes selected global state
 * values to topics under config.mqtt.topic_prefix on an interval, and sets the
 * birth/will status topic. Subscriptions can be added for inbound HA control.
 */
const state = require('./state');

let mqttLib = null;
let client = null;
let cfg = null;
let publishTimer = null;

// Inbound subscriptions registered by other services (e.g. Home Assistant state
// monitoring). Map of topic -> array of handler(topic, payloadString).
const subscriptions = new Map();

function tryLoadLib() {
  if (mqttLib) return true;
  try { mqttLib = require('mqtt'); return true; }
  catch { console.warn('[mqtt] mqtt package not available - MQTT bridge disabled.'); return false; }
}

function start(config) {
  cfg = config && config.mqtt;
  if (!cfg || !cfg.enabled) { console.log('[mqtt] disabled in config.'); return; }
  if (!tryLoadLib()) return;

  const url = `mqtt://${cfg.broker}:${cfg.port || 1883}`;
  const opts = {
    clientId: cfg.client_id || 'hamcontrol_web',
    keepalive: cfg.keepalive || 60,
    reconnectPeriod: 5000,
    username: cfg.username || undefined,
    password: cfg.password || undefined,
    will: cfg.will_topic ? { topic: cfg.will_topic, payload: cfg.will_payload || 'offline', retain: true } : undefined
  };

  try {
    client = mqttLib.connect(url, opts);
    client.on('connect', () => {
      console.log(`[mqtt] connected to ${url}`);
      state.update('mqtt', { connected: true });
      if (cfg.birth_topic) client.publish(cfg.birth_topic, cfg.birth_payload || 'online', { retain: true });
      resubscribeAll();
      startPublishing();
    });
    client.on('reconnect', () => state.update('mqtt', { connected: false }));
    client.on('close', () => state.update('mqtt', { connected: false }));
    client.on('error', (e) => console.warn('[mqtt] error:', e.message));
    client.on('message', (topic, payload) => {
      const handlers = subscriptions.get(topic);
      if (!handlers || !handlers.length) return;
      const text = payload ? payload.toString() : '';
      console.log(`[mqtt] <- ${topic} = ${text}`);
      handlers.forEach((fn) => {
        try { fn(topic, text); } catch (e) { console.warn(`[mqtt] handler error for ${topic}:`, e.message); }
      });
    });
  } catch (err) {
    console.warn('[mqtt] connect failed:', err.message);
  }
}

function startPublishing() {
  if (publishTimer) clearInterval(publishTimer);
  const interval = (cfg.publish_interval_sec || 60) * 1000;
  const prefix = cfg.topic_prefix || 'hamcontrol/global';
  const publish = () => {
    if (!client || !client.connected) return;
    const s = state.get();
    const map = {
      powerSupply: s.power.powerSupply,
      radioPower: s.power.radioPower,
      ampPower: s.power.ampPower,
      ampStatus: s.amp.status,
      amp: s.amp.mode,
      tuner: s.tuner.mode,
      TXStatus: s.flexradio.txStatus
    };
    for (const [k, v] of Object.entries(map)) {
      client.publish(`${prefix}/${k}`, String(v), { retain: true });
    }
  };
  publish();
  publishTimer = setInterval(publish, interval);
}

/**
 * Register an inbound subscription. The handler is called as handler(topic, text)
 * whenever a retained/live message arrives on `topic`. Safe to call before the
 * client connects - topics are (re)subscribed on each (re)connect.
 */
function subscribe(topic, handler) {
  if (!topic || typeof handler !== 'function') return;
  if (!subscriptions.has(topic)) subscriptions.set(topic, []);
  subscriptions.get(topic).push(handler);
  if (client && client.connected) {
    client.subscribe(topic, (err) => {
      if (err) console.warn(`[mqtt] subscribe failed for ${topic}:`, err.message);
      else console.log(`[mqtt] subscribed to ${topic}`);
    });
  }
}

/** (Re)subscribe to every registered topic - called on connect/reconnect. */
function resubscribeAll() {
  if (!client) return;
  const topics = Array.from(subscriptions.keys());
  if (!topics.length) return;
  client.subscribe(topics, (err) => {
    if (err) console.warn('[mqtt] resubscribe failed:', err.message);
    else console.log(`[mqtt] subscribed to ${topics.length} topic(s): ${topics.join(', ')}`);
  });
}

/** True when the MQTT client is connected (used by other services). */
function isConnected() {
  return !!(client && client.connected);
}

/** Publish a single value immediately (used by control actions). */
function publishValue(key, value) {
  if (!client || !client.connected) return;
  const prefix = cfg.topic_prefix || 'hamcontrol/global';
  client.publish(`${prefix}/${key}`, String(value), { retain: true });
}

function stop() {
  if (publishTimer) clearInterval(publishTimer);
  if (client) try { client.end(true); } catch {}
}

module.exports = { start, stop, publishValue, subscribe, isConnected };
