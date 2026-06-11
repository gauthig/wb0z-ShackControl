/**
 * serial.js - Palstar LA-1K amplifier control over a serial port (default COM7).
 *
 * Uses the `serialport` npm package. The package is loaded lazily so the app
 * still runs (in simulation mode) on machines where the native module is not
 * installed or no COM port is present.
 *
 * Protocol (from Node-RED extraction):
 *   poll:      AR1;\r\n   (poll status, ~1/sec)
 *   operate:   AM1;\r\n
 *   standby:   AM2;\r\n
 *   antenna:   AA{1|2|3};\r\n
 *   frequency: IF{8-digit padded};\r\n
 *   Response is a CSV line; fields are parsed by index.
 */
const state = require('./state');

let SerialPortLib = null;
let port = null;
let pollTimer = null;
let cfg = null;
let buffer = '';

function tryLoadLib() {
  if (SerialPortLib) return true;
  try {
    SerialPortLib = require('serialport').SerialPort;
    return true;
  } catch (err) {
    console.warn('[serial] serialport package not available - amp running in SIMULATION mode.');
    return false;
  }
}

function start(config) {
  cfg = config && config.serial && config.serial.palstar_la1k_amp;
  if (!cfg || !cfg.enabled) {
    console.log('[serial] Palstar amp disabled in config.');
    return;
  }
  if (!tryLoadLib()) {
    state.update('amp', { connected: false, status: 'sim' });
    return;
  }
  open();
}

function open() {
  try {
    port = new SerialPortLib({
      path: cfg.serial_port,
      baudRate: cfg.baud_rate || 9600,
      dataBits: cfg.data_bits || 8,
      parity: cfg.parity || 'none',
      stopBits: cfg.stop_bits || 1,
      autoOpen: false
    });

    port.open((err) => {
      if (err) {
        console.warn(`[serial] Could not open ${cfg.serial_port}: ${err.message}`);
        state.update('amp', { connected: false });
        scheduleReopen();
        return;
      }
      console.log(`[serial] Opened ${cfg.serial_port} @ ${cfg.baud_rate}`);
      state.update('amp', { connected: true });
      startPolling();
    });

    port.on('data', (data) => {
      const chunk = data.toString('utf8');
      buffer += chunk;
      if (cfg.debug_raw) console.log('[serial] rx raw:', JSON.stringify(chunk));
      // The amp's RS232 port is Kenwood-CAT-style: responses are terminated
      // with ';' (not newline). Accept ';', CR or LF as end-of-response.
      let m;
      while ((m = buffer.match(/[;\r\n]/))) {
        const line = buffer.slice(0, m.index).trim();
        buffer = buffer.slice(m.index + 1);
        if (line) parseResponse(line);
      }
      // Runaway guard if no terminator ever arrives.
      if (buffer.length > 500) {
        console.warn('[serial] rx buffer overflow without terminator, clearing:', JSON.stringify(buffer.slice(0, 120)));
        buffer = '';
      }
    });

    port.on('close', () => {
      state.update('amp', { connected: false });
      scheduleReopen();
    });
    port.on('error', (e) => console.warn('[serial] error:', e.message));
  } catch (err) {
    console.warn('[serial] open failed:', err.message);
    scheduleReopen();
  }
}

function scheduleReopen() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  setTimeout(() => { if (cfg && cfg.enabled) open(); }, 5000);
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const interval = (cfg.protocol.poll_interval_sec || 1) * 1000;
  pollTimer = setInterval(() => write(cfg.protocol.poll_command), interval);
}

/** Ham band name from a frequency in MHz (covers band edges generously). */
function bandFromMHz(mhz) {
  if (!mhz) return '';
  const bands = [
    [1.7, 2.1, '160M'], [3.4, 4.1, '80M'], [5.2, 5.5, '60M'],
    [6.9, 7.4, '40M'], [10.0, 10.2, '30M'], [13.9, 14.4, '20M'],
    [18.0, 18.2, '17M'], [20.9, 21.5, '15M'], [24.8, 25.0, '12M'],
    [27.9, 29.8, '10M'], [49.9, 54.1, '6M']
  ];
  const hit = bands.find(([lo, hi]) => mhz >= lo && mhz <= hi);
  return hit ? hit[2] : '';
}

/** Parse the CSV status line from the amp. */
function parseResponse(line) {
  const f = line.split(',');
  if (cfg.debug_raw) console.log(`[serial] rx line (${f.length} fields):`, JSON.stringify(line));
  if (f.length < 12) return;
  const proto = cfg.protocol;
  const keyCode = f[4];
  const modeOperate = state.get().amp.mode === 'operate';
  const freqMHz = parseInt(f[1], 10) / 1000 || 0;
  const tempC = parseInt(f[10], 10) || 0;
  state.update('amp', {
    frequency: freqMHz,
    fwdPower: (parseInt(f[2], 10) || 0) * (modeOperate ? 10 : 1),
    // Derive the band from frequency (per-band labels) rather than the amp's
    // band code, which only identifies the shared LPF filter bank.
    band: bandFromMHz(freqMHz) || proto.band_codes[f[3]] || '',
    keyStatus: proto.key_status_codes[keyCode] || 'Unkeyed',
    // The amp reports °C; the dashboard shows °F. Set temperature_in: "F"
    // in config if a firmware turns out to report Fahrenheit already.
    temperature: cfg.temperature_in === 'F' ? tempC : Math.round(tempC * 9 / 5 + 32),
    antenna: parseInt(f[11], 10) || 1
  });
}

function write(command) {
  if (port && port.isOpen) {
    port.write(command);
  }
}

/* ---- Public control API (called by REST routes) ---- */
function setMode(mode) {
  const proto = cfg && cfg.protocol;
  if (mode === 'operate') { write(proto && proto.operate_command); state.update('amp', { mode: 'operate' }); }
  else { write(proto && proto.standby_command); state.update('amp', { mode: 'standby' }); }
  return state.get().amp.mode;
}

function selectAntenna(n) {
  const proto = cfg && cfg.protocol;
  if (proto && proto.antenna_select_command) {
    write(proto.antenna_select_command.replace('{n}', String(n)));
  }
  state.update('amp', { antenna: Number(n) });
  return n;
}

function setFrequency(khz) {
  const proto = cfg && cfg.protocol;
  if (proto && proto.frequency_command) {
    const padded = String(Math.round(khz)).padStart(8, '0');
    write(proto.frequency_command.replace('{freq_padded_8}', padded));
  }
}

function stop() {
  if (pollTimer) clearInterval(pollTimer);
  if (port && port.isOpen) port.close();
}

module.exports = { start, stop, setMode, selectAntenna, setFrequency };
