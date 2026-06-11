/**
 * tuner.js - Direct serial control of the Palstar HF-Auto tuner.
 *
 * Replaces the HF-AUTO Controller UDP bridge. Speaks the tuner's native
 * binary protocol directly on the COM port (default COM4, 4800 baud 8N2).
 *
 * Protocol (reverse-engineered; see github.com/hexnoctal/hf-auto-tuner):
 *
 *   Status frame — streamed continuously by the tuner, 12 bytes:
 *     [0]  0x77 frame header
 *     [1]  mode: 1=AUTO  2=MANUAL  3=BYPASS
 *     [2]  frequency high byte (value in kHz)
 *     [3]  frequency low byte
 *     [4]  capacitance step
 *     [5]  antenna port packed in bits 2-3 of the low nibble (1..3)
 *     [6]  inductance step
 *     [7]  unknown — NOT power-high: reads ~0x13 at 5 W on this firmware
 *     [8]  power low byte (watts)
 *     [9]  bits 4-7 are status flags on this firmware (0xC0 seen during TX);
 *          bits 0-3 may extend VSWR above 2.55
 *     [10] VSWR low byte (value / 100)
 *     [11] checksum — two's complement of the sum of bytes 0..10
 *
 *   Command frame — 4 bytes: 0x7A, mnemonic, value, checksum (same formula):
 *     mnemonic 0x31..0x33 ('1'..'3') = select antenna port (value 0x00)
 *     mnemonic 0x61 ('a') = AUTO mode   (value 0x00)
 *     mnemonic 0x62 ('b') = BYPASS mode (value 0x00)
 *   MANUAL mode has no known serial command — it is set on the front panel.
 */
const { SerialPort } = require('serialport');
const state = require('./state');

const FRAME_LEN = 12;
const STATUS_HEADER = 0x77;
const CMD_HEADER = 0x7a;
const MODE_NAMES = { 1: 'AUTO', 2: 'MANUAL', 3: 'BYPASS' };
const PEAK_HOLD_MS = 5000;

let port = null;
let cfg = null;
let watchdog = null;
let lastData = 0;
let rxBuf = Buffer.alloc(0);
let peakPower = 0;
let peakTime = 0;
let lastFrameHex = '';
let lastFrameLog = 0;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
function start(config) {
  cfg = config && config.serial && config.serial.palstar_hf_auto_tuner;
  if (!cfg || !cfg.enabled) return;

  try {
    port = new SerialPort({
      path: cfg.serial_port || 'COM4',
      baudRate: Number(cfg.baud_rate) || 4800,
      dataBits: 8,
      parity: 'none',
      stopBits: Number(cfg.stop_bits) || 2,
      autoOpen: false
    });

    port.on('data', onData);

    port.on('error', (err) => {
      console.error('[tuner] serial error:', err.message);
      state.update('tuner', { connected: false });
    });

    port.on('close', () => {
      console.warn('[tuner] port closed');
      state.update('tuner', { connected: false, online: false });
    });

    port.open((err) => {
      if (err) {
        console.error('[tuner] cannot open', cfg.serial_port, '-', err.message);
        state.update('tuner', { connected: false });
        return;
      }
      console.log(`[tuner] ${cfg.serial_port} opened at ${cfg.baud_rate || 4800} baud 8N2`);
      // The tuner's remote port expects DTR asserted before it streams status.
      port.set({ dtr: true }, () => {});
      state.update('tuner', { connected: true });
      _startWatchdog();
    });
  } catch (err) {
    console.error('[tuner] start error:', err.message);
  }
}

function stop() {
  if (watchdog) clearInterval(watchdog);
  if (port && port.isOpen) try { port.close(); } catch {}
}

// ---------------------------------------------------------------------------
// Receive path — accumulate bytes, extract checksum-valid 12-byte frames
// ---------------------------------------------------------------------------
function checksum(buf, len) {
  let sum = 0;
  for (let i = 0; i < len; i++) sum += buf[i];
  return (-sum) & 0xff; // two's complement → all bytes incl. checksum sum to 0
}

function onData(chunk) {
  rxBuf = Buffer.concat([rxBuf, chunk]);

  // Scan for the status header and validate; skip noise/partial frames.
  let i = 0;
  while (i <= rxBuf.length - FRAME_LEN) {
    if (rxBuf[i] !== STATUS_HEADER) { i++; continue; }
    const frame = rxBuf.subarray(i, i + FRAME_LEN);
    if (frame[FRAME_LEN - 1] === checksum(frame, FRAME_LEN - 1)) {
      parseStatusFrame(frame);
      i += FRAME_LEN;
    } else {
      i++; // header byte was data, resync on the next byte
    }
  }
  rxBuf = rxBuf.subarray(i);
  // Never let garbage grow unbounded if the header byte stops appearing.
  if (rxBuf.length > 256) rxBuf = rxBuf.subarray(rxBuf.length - FRAME_LEN);
}

function parseStatusFrame(f) {
  lastData = Date.now();

  // With debug_frames enabled in config, log raw frames (throttled, only when
  // the content changes) so unknown byte fields can be mapped from get_logs.
  if (cfg.debug_frames) {
    const hex = f.toString('hex');
    if (hex !== lastFrameHex && Date.now() - lastFrameLog > 1000) {
      console.log('[tuner] frame:', hex.replace(/../g, '$& ').trim());
      lastFrameHex = hex;
      lastFrameLog = Date.now();
    }
  }

  const freqKHz = (f[2] << 8) | f[3];
  const power = f[8];
  const swr = (((f[9] & 0x0f) << 8) | f[10]) / 100;
  const antenna = (f[5] & 0x0f) >> 2;

  // Peak-hold the power reading so short SSB/CW peaks stay visible.
  if (power >= peakPower || Date.now() - peakTime > PEAK_HOLD_MS) {
    peakPower = power;
    peakTime = Date.now();
  }

  state.update('tuner', {
    connected: true,
    online: true,
    mode: MODE_NAMES[f[1]] || 'UNKNOWN',
    frequency: freqKHz / 1000, // MHz
    capacitance: f[4],
    inductance: f[6],
    antenna: antenna >= 1 && antenna <= 3 ? antenna : state.get().tuner.antenna,
    power,
    peakPower,
    swr
  });
}

function _startWatchdog() {
  if (watchdog) clearInterval(watchdog);
  const timeout = (cfg.watchdog_timeout_sec || 10) * 1000;
  watchdog = setInterval(() => {
    if (Date.now() - lastData > timeout) {
      state.update('tuner', { online: false });
    }
  }, 5000);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function _sendCmd(mnemonic, value = 0) {
  if (!port || !port.isOpen) return;
  const frame = Buffer.from([CMD_HEADER, mnemonic, value, 0]);
  frame[3] = checksum(frame, 3);
  port.write(frame, (err) => {
    if (err) console.warn('[tuner] write error:', err.message);
  });
}

/** Select antenna port 1-3, then apply any configured force_mode rule. */
function selectAntenna(n) {
  const ant = Math.max(1, Math.min(3, Number(n)));
  _sendCmd(0x30 + ant); // ASCII '1'..'3'
  state.update('tuner', { antenna: ant });
  const rule = cfg && cfg.antenna_rules && cfg.antenna_rules[String(ant)];
  if (rule && rule.force_mode) {
    // Give the tuner time to finish the relay switch before the mode change.
    setTimeout(() => setMode(rule.force_mode), 800);
  }
  return ant;
}

/** Set operating mode: 'AUTO' or 'BYPASS' (MANUAL is front-panel only). */
function setMode(mode) {
  const m = String(mode).toUpperCase();
  if (m === 'AUTO') _sendCmd(0x61);
  else if (m === 'BYPASS') _sendCmd(0x62);
  else return null;
  state.update('tuner', { mode: m });
  return m;
}

module.exports = { start, stop, selectAntenna, setMode };
