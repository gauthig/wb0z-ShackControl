/**
 * state.js - Central live state for every device, plus a tiny event bus.
 *
 * Services (serial/udp/mqtt/flexradio) push updates here via update().
 * The WebSocket layer subscribes via onChange() and broadcasts to clients.
 * The REST API reads the current snapshot via get().
 */
const EventEmitter = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

const state = {
  power: {
    powerSupply: false,
    radioPower: false,
    ampPower: false
  },
  flexradio: {
    connected: false,
    radioLinkOK: false,
    clientName: '',
    txStatus: 'RECEIVE',
    rfpower: 0,
    apd: { enable: 0, configurable: 0, equalizer_active: 0 },
    activeSlice: 'A',
    slices: {
      A: { freq: 0, mode: '', active: 1 },
      B: { freq: 0, mode: '', active: 0 },
      C: { freq: 0, mode: '', active: 0 },
      D: { freq: 0, mode: '', active: 0 }
    },
    meters: {
      swr: 0,
      fwd_power: 0,
      pa_temp: 0,
      fan_rpm: 0,
      pa_volts: 0,
      pa_current: 0,
      mic_peak: 0,
      comp_peak: 0,
      gain: 0,
      sc_mic: 0
    },
    lastActivity: 0
  },
  rotator: {
    connected: false,
    azimuth: 0,
    target: null,
    moving: false
  },
  amp: {
    connected: false,
    mode: 'standby',
    status: '',
    frequency: 0,
    fwdPower: 0,
    band: '',
    keyStatus: 'Unkeyed',
    temperature: 0,
    antenna: 1
  },
  tuner: {
    connected: false,
    online: false,
    mode: 'BYPASS',
    antenna: 1,
    frequency: 0,
    capacitance: 0,
    inductance: 0,
    swr: 0,
    power: 0,
    peakPower: 0
  },
  mqtt: { connected: false },
  home_assistant: {
    enabled: false,   // integration configured & ready (base_url + token)
    syncing: false,   // a state sync/poll is currently in flight
    lastSync: 0,      // timestamp of last successful state read
    lastError: null,  // last error string (null when healthy)
    source: ''        // 'startup' | 'poll' | 'mqtt' | 'command' (what last updated power)
  },
  serverTime: Date.now()
};

/**
 * Deep-merge a partial update into a section and emit a change event.
 * @param {string} section  e.g. 'flexradio'
 * @param {object} partial  fields to merge
 */
function update(section, partial) {
  if (!state[section]) state[section] = {};
  deepMerge(state[section], partial);
  state.serverTime = Date.now();
  bus.emit('change', { section, partial });
}

function deepMerge(target, src) {
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      deepMerge(target[k], src[k]);
    } else {
      target[k] = src[k];
    }
  }
}

function get() {
  state.serverTime = Date.now();
  return state;
}

function onChange(fn) {
  bus.on('change', fn);
  return () => bus.off('change', fn);
}

module.exports = { update, get, onChange, bus };
