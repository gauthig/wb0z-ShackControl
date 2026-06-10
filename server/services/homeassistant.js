/**
 * homeassistant.js - Controls Home Assistant entities via the HA REST API.
 *
 * This mirrors what the original Node-RED flow did: it calls Home Assistant
 * service actions (switch.turn_on / switch.turn_off, light.turn_on, ...) on
 * specific entity_ids. Plain MQTT publishes to `hamcontrol/global/*` are only
 * *status mirrors* for HA to read - they do NOT command the smart plugs/relays.
 * Actual on/off control must go through the HA service API (or a device's own
 * native command topic), which is what this module implements.
 *
 * Requires (in config.home_assistant):
 *   - enabled:  true
 *   - base_url: e.g. "http://192.168.1.54:8123"
 *   - token:    a Home Assistant long-lived access token
 *   - entities: { power_supply:{entity_id}, amplifier:{entity_id}, radio_relay:{entity_id}, ... }
 */
const state = require('./state');
const mqtt = require('./mqtt');

let cfg = null;
let pollTimer = null;

/**
 * Logical device key -> the boolean field in state.power that the UI binds to.
 * These three are the powered devices the dashboard shows/toggles.
 */
const DEVICE_MAP = {
  power_supply: 'powerSupply',
  radio_relay: 'radioPower',
  amplifier: 'ampPower'
};

function start(config) {
  cfg = (config && config.home_assistant) || {};
  stopPolling();

  if (!cfg.enabled) {
    console.log('[ha] Home Assistant integration disabled in config (power toggles will not reach HA).');
    state.update('home_assistant', { enabled: false, syncing: false });
    return;
  }
  if (!cfg.base_url) {
    console.warn('[ha] enabled but no base_url set (expected e.g. http://192.168.1.54:8123) - control disabled.');
  }
  if (!cfg.token) {
    console.warn('[ha] enabled but no long-lived access token set - HA will reject service calls (401).');
  }
  console.log(`[ha] Home Assistant control ready -> ${cfg.base_url || '(no base_url)'}`);
  state.update('home_assistant', { enabled: isReady(), lastError: null });

  // 1) Real-time monitoring via MQTT state topics (if configured per entity).
  setupMqttStateMonitoring();

  // 2) Initial state sync from the HA REST API shortly after startup
  //    (gives MQTT a moment to connect first). Then poll periodically as a
  //    reliable fallback / discrepancy detector.
  if (isReady()) {
    setTimeout(() => {
      syncAllStates('startup').catch((e) => console.warn('[ha] initial sync error:', e.message));
      startPolling();
    }, 1500);
  } else {
    console.warn('[ha] skipping initial state sync - base_url/token not configured.');
  }
}

function isReady() {
  return !!(cfg && cfg.enabled && cfg.base_url && cfg.token);
}

/** Resolve a logical device name to its configured HA entity_id. */
function entityIdFor(deviceKey) {
  const ent = (cfg && cfg.entities) || {};
  const node = ent[deviceKey];
  return node && node.entity_id;
}

/**
 * Call a Home Assistant service action.
 * @param {string} domain   e.g. 'switch' | 'light'
 * @param {string} service  e.g. 'turn_on' | 'turn_off'
 * @param {string} entityId target entity_id
 * @param {object} [data]   extra service data (e.g. brightness/rgb for lights)
 * @returns {Promise<{ok:boolean, status?:number, error?:string}>}
 */
async function callService(domain, service, entityId, data) {
  if (!cfg || !cfg.enabled) {
    console.warn(`[ha] skip ${domain}.${service} ${entityId} - integration disabled.`);
    return { ok: false, error: 'disabled' };
  }
  if (!cfg.base_url || !cfg.token) {
    console.warn(`[ha] skip ${domain}.${service} ${entityId} - base_url/token not configured.`);
    return { ok: false, error: 'not_configured' };
  }
  if (!entityId) {
    console.warn(`[ha] skip ${domain}.${service} - no entity_id mapped.`);
    return { ok: false, error: 'no_entity' };
  }

  const url = `${cfg.base_url.replace(/\/+$/, '')}/api/services/${domain}/${service}`;
  const body = Object.assign({ entity_id: entityId }, data || {});
  const t0 = Date.now();
  console.log(`[ha] -> POST ${url} ${JSON.stringify(body)}`);

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (cfg.timeout_ms || 5000));
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const text = await resp.text().catch(() => '');
    const ms = Date.now() - t0;
    if (resp.ok) {
      console.log(`[ha] <- ${resp.status} ${domain}.${service} ${entityId} OK (${ms}ms)`);
      return { ok: true, status: resp.status };
    }
    console.error(`[ha] <- ${resp.status} ${domain}.${service} ${entityId} FAILED (${ms}ms): ${text.slice(0, 200)}`);
    return { ok: false, status: resp.status, error: text || `HTTP ${resp.status}` };
  } catch (err) {
    const ms = Date.now() - t0;
    const msg = err.name === 'AbortError' ? `timeout after ${cfg.timeout_ms || 5000}ms` : err.message;
    console.error(`[ha] <- ERROR ${domain}.${service} ${entityId} (${ms}ms): ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Query the current state of a single entity from the HA REST API.
 * @param {string} entityId
 * @returns {Promise<{ok:boolean, on?:boolean, state?:string, error?:string}>}
 */
async function getState(entityId) {
  if (!isReady()) return { ok: false, error: 'not_configured' };
  if (!entityId) return { ok: false, error: 'no_entity' };

  const url = `${cfg.base_url.replace(/\/+$/, '')}/api/states/${encodeURIComponent(entityId)}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (cfg.timeout_ms || 5000));
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error(`[ha] getState ${entityId} FAILED ${resp.status}: ${text.slice(0, 160)}`);
      return { ok: false, status: resp.status, error: text || `HTTP ${resp.status}` };
    }
    const json = await resp.json();
    const on = parseOnOff(json && json.state);
    return { ok: true, on, state: json && json.state };
  } catch (err) {
    const msg = err.name === 'AbortError' ? `timeout after ${cfg.timeout_ms || 5000}ms` : err.message;
    console.error(`[ha] getState ${entityId} ERROR: ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Interpret an HA / MQTT payload as a boolean on/off.
 * Accepts: on/off, ON/OFF, true/false, 1/0, and JSON like {"state":"on"} or
 * Shelly/Tasmota style {"output":true} / {"POWER":"ON"}.
 * @returns {boolean|null} null when undeterminable.
 */
function parseOnOff(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  let v = String(value).trim();
  // Try JSON payloads first.
  if (v.startsWith('{') || v.startsWith('[')) {
    try {
      const obj = JSON.parse(v);
      const cand = obj.state ?? obj.POWER ?? obj.power ?? obj.output ?? obj.value ?? obj.on;
      if (cand !== undefined) return parseOnOff(cand);
    } catch { /* fall through to string parsing */ }
  }
  v = v.toLowerCase();
  if (['on', 'true', '1', 'open', 'home', 'active', 'online'].includes(v)) return true;
  if (['off', 'false', '0', 'closed', 'away', 'inactive', 'offline'].includes(v)) return false;
  return null;
}

/**
 * Apply a known device on/off value into central state.power, logging any
 * discrepancy between what the UI currently shows and the real device state.
 * @param {string} deviceKey  power_supply|radio_relay|amplifier
 * @param {boolean} on
 * @param {string} source     where this update came from (startup|poll|mqtt|command)
 */
function applyDeviceState(deviceKey, on, source) {
  const stateKey = DEVICE_MAP[deviceKey];
  if (!stateKey) return;
  const cur = state.get().power[stateKey];
  if (cur !== on) {
    console.log(`[ha] STATE CHANGE ${deviceKey} (${stateKey}): UI=${cur} -> actual=${on} [source:${source}]`);
  } else {
    console.log(`[ha] state confirmed ${deviceKey} (${stateKey})=${on} [source:${source}]`);
  }
  state.update('power', { [stateKey]: on });
  state.update('home_assistant', { source });
}

/**
 * Read all three powered devices from HA and push their real states into the
 * central state (which auto-broadcasts to all WebSocket clients).
 * @param {string} source startup|poll|command
 */
async function syncAllStates(source = 'poll') {
  if (!isReady()) {
    console.warn('[ha] syncAllStates skipped - not configured.');
    return { ok: false, error: 'not_configured' };
  }
  state.update('home_assistant', { syncing: true });
  console.log(`[ha] syncing device states from HA REST API [source:${source}]...`);

  const results = {};
  let anyError = null;
  for (const [deviceKey, stateKey] of Object.entries(DEVICE_MAP)) {
    const entityId = entityIdFor(deviceKey);
    if (!entityId) { console.warn(`[ha] no entity_id mapped for ${deviceKey} - skipping.`); continue; }
    const r = await getState(entityId);
    if (r.ok && r.on !== null) {
      applyDeviceState(deviceKey, r.on, source);
      results[stateKey] = r.on;
    } else {
      anyError = r.error || 'unknown';
      console.warn(`[ha] could not read ${deviceKey} (${entityId}): ${anyError}`);
    }
  }

  state.update('home_assistant', {
    syncing: false,
    lastSync: Date.now(),
    lastError: anyError
  });
  console.log(`[ha] sync complete [source:${source}] -> ${JSON.stringify(results)}${anyError ? ' (with errors: ' + anyError + ')' : ''}`);
  return { ok: !anyError, states: results, error: anyError };
}

/** Begin periodic REST polling to keep state in sync (discrepancy detector). */
function startPolling() {
  stopPolling();
  const sec = (cfg.polling_interval_sec || (cfg.power_sequencing && cfg.power_sequencing.polling_interval_sec) || 15);
  if (!sec || sec <= 0) { console.log('[ha] periodic polling disabled (polling_interval_sec<=0).'); return; }
  console.log(`[ha] periodic state polling every ${sec}s.`);
  pollTimer = setInterval(() => {
    syncAllStates('poll').catch((e) => console.warn('[ha] poll error:', e.message));
  }, sec * 1000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/**
 * Subscribe to HA MQTT state topics for real-time updates. A device gets
 * monitored when its config entry has a `state_topic`, e.g.:
 *   entities.amplifier = { entity_id: "switch.smart_plug_2", state_topic: "stat/amp/POWER" }
 * Payloads are parsed with parseOnOff(). This is best-effort and additive to
 * REST polling - if no topics are configured, polling alone keeps things synced.
 */
function setupMqttStateMonitoring() {
  const ent = (cfg && cfg.entities) || {};
  let count = 0;
  for (const [deviceKey, node] of Object.entries(ent)) {
    if (!DEVICE_MAP[deviceKey]) continue; // only the 3 powered devices
    const topic = node && node.state_topic;
    if (!topic) continue;
    mqtt.subscribe(topic, (t, payload) => {
      const on = parseOnOff(payload);
      if (on === null) {
        console.warn(`[ha] mqtt ${t} payload not understood as on/off: "${payload}"`);
        return;
      }
      applyDeviceState(deviceKey, on, 'mqtt');
      state.update('home_assistant', { lastSync: Date.now(), lastError: null });
    });
    console.log(`[ha] monitoring MQTT state topic for ${deviceKey}: ${topic}`);
    count++;
  }
  if (!count) {
    console.log('[ha] no per-entity MQTT state_topic configured - relying on REST polling for real-time sync.');
  }
}

/**
 * Turn a logical switch device on/off via HA, then confirm the resulting state.
 * @param {string} deviceKey one of the configured entity keys (power_supply|amplifier|radio_relay)
 * @param {boolean} on
 * @returns {Promise<{ok:boolean, status?:number, error?:string, confirmed?:boolean}>}
 */
async function setSwitch(deviceKey, on) {
  const entityId = entityIdFor(deviceKey);
  const service = on ? 'turn_on' : 'turn_off';
  console.log(`[ha] setSwitch ${deviceKey} -> ${service} (entity_id=${entityId || 'unmapped'})`);
  const result = await callService('switch', service, entityId, null);

  if (!result.ok) {
    state.update('home_assistant', { lastError: `${deviceKey}: ${result.error}` });
    return result;
  }
  state.update('home_assistant', { lastError: null });

  // Confirm the new state from HA and broadcast the *actual* value. HA needs a
  // brief moment to reflect the change, so wait before reading back.
  await new Promise((r) => setTimeout(r, cfg.confirm_delay_ms || 600));
  const verify = await getState(entityId);
  if (verify.ok && verify.on !== null) {
    applyDeviceState(deviceKey, verify.on, 'command');
    state.update('home_assistant', { lastSync: Date.now() });
    if (verify.on !== on) {
      console.warn(`[ha] command/confirm mismatch for ${deviceKey}: requested ${on}, HA reports ${verify.on}`);
    }
    result.confirmed = verify.on;
  } else {
    console.warn(`[ha] could not confirm ${deviceKey} state after command: ${verify.error}`);
    result.confirmed = undefined;
  }
  return result;
}

module.exports = {
  start, stop, isReady, callService, setSwitch, entityIdFor,
  getState, syncAllStates, parseOnOff
};

/** Graceful shutdown - stop polling. */
function stop() {
  stopPolling();
}
