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
      buffer += data.toString('utf8');
      // The amp streams a status record terminated by CR (\r). Fields WITHIN
      // the record are themselves ';'-delimited, so CR/LF is the only record
      // terminator — never split on ';'.
      let m;
      while ((m = buffer.match(/[\r\n]/))) {
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

/**
 * Parse the amp's status record. Fields are ';'-delimited (firmware 1.09E):
 *   0  AD14294   "AD" + frequency in kHz   -> 14.294 MHz
 *   1  2         mode echo (1=operate 2=standby)
 *   2  000       forward power (watts)
 *   3  11        (TBD)
 *   4  1         (TBD)
 *   5  4         (TBD)
 *   6  50        (TBD)
 *   7  001       (TBD)
 *   8  025       temperature (°C)  [best guess — verifying]
 *   9  1023      (TBD — likely a 10-bit ADC reading)
 *   10 0         key status (0=Unkeyed ...)  [best guess — verifying]
 *   11 1         (TBD)
 *   12 1         antenna (1..3)  [best guess — verifying]
 *   13 |/-\      activity spinner (ignored)
 *   14 1.09E     firmware version
 */
function parseResponse(line) {
  const f = line.split(';').map((s) => s.trim());
  if (cfg.debug_raw) {
    console.log(`[serial] rx record (${f.length} fields):`, JSON.stringify(f));
  }
  if (f.length < 13) return;
  const proto = cfg.protocol;

  const freqMHz = (parseInt(String(f[0]).replace(/\D/g, ''), 10) || 0) / 1000;
  const fwd = parseInt(f[2], 10) || 0;
  const tempC = parseInt(f[8], 10) || 0;
  const keyCode = f[10];

  // NOTE: antenna is NOT taken from the status record. Field 12 stays "1"
  // regardless of the amp's actual antenna, so reading it here would stomp the
  // user's selection back to 1 on every poll. The selected antenna is tracked
  // optimistically in selectAntenna() instead. (If a future capture reveals the
  // real antenna field, reflect it here.)
  const patch = {
    frequency: freqMHz,
    // Derive band from frequency for per-band labels.
    band: bandFromMHz(freqMHz),
    fwdPower: fwd,
    // Amp reports °C; dashboard shows °F. Set temperature_in:"F" to skip.
    temperature: cfg.temperature_in === 'F' ? tempC : Math.round(tempC * 9 / 5 + 32),
    keyStatus: proto.key_status_codes[keyCode] || 'Unkeyed'
  };
  state.update('amp', patch);
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

/**
 * Send the operating frequency so the amp can pre-select the band filter before
 * TX (the amp is otherwise RF-sensing and only learns the band on first key-up).
 * The command template supports {freq_khz}, {freq_mhz} and {freq_padded_8}.
 */
function setFrequency(khz) {
  const proto = cfg && cfg.protocol;
  if (!proto || !proto.frequency_command) return;
  const k = Math.round(khz);
  if (!k || k <= 0) return;
  const cmd = proto.frequency_command
    .replace('{freq_khz}', String(k))
    .replace('{freq_padded_8}', String(k).padStart(8, '0'))
    .replace('{freq_mhz}', (k / 1000).toFixed(3));
  if (cfg.debug_raw) console.log('[serial] tx freq:', JSON.stringify(cmd));
  write(cmd);
  lastSentKHz = k;
}

/**
 * Called by the FlexRadio service when the active-slice frequency changes.
 * Debounced (the VFO streams updates while spinning) and deduped at kHz so the
 * amp only hears real band moves. Disabled unless serial.send_frequency is set.
 */
let lastSentKHz = 0;
let freqDebounce = null;
function notifyFrequencyMHz(mhz) {
  if (!cfg || !cfg.send_frequency) return;
  const khz = Math.round(Number(mhz) * 1000);
  if (!khz || khz <= 0 || khz === lastSentKHz) return;
  if (freqDebounce) clearTimeout(freqDebounce);
  freqDebounce = setTimeout(() => setFrequency(khz), 400);
}

function stop() {
  if (pollTimer) clearInterval(pollTimer);
  if (freqDebounce) clearTimeout(freqDebounce);
  if (port && port.isOpen) port.close();
}

module.exports = { start, stop, setMode, selectAntenna, setFrequency, notifyFrequencyMHz };
