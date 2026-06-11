/**
 * tuner.js - Direct serial control of the Palstar HF-Auto tuner.
 *
 * Replaces the HF-AUTO Controller UDP bridge. Speaks the tuner's native
 * binary protocol directly on the COM port (default COM4, 4800 baud 8N2).
 *
 * Protocol decoded from the HF-AUTO Controller app (MW0LGE) decoder IL,
 * cross-checked with github.com/hexnoctal/hf-auto-tuner:
 *
 *   Status frame — streamed continuously by the tuner, 12 bytes:
 *     [0]  0x77 frame header
 *     [1]  mode: 0=STARTUP 1=AUTO 2=MANUAL 3=BYPASS 4=SETUP
 *     [2]  frequency high byte (kHz; in STARTUP mode bytes 2-3 carry the
 *          firmware version * 100 instead)
 *     [3]  frequency low byte
 *     [4]  capacitance step
 *     [5]  bits 0-1: inductance high bits · bits 2-3: antenna port (1..3)
 *          bits 4-5: stepper-motor selection (1=IND else CAP)
 *     [6]  inductance low byte (L is 10-bit: ((b5 & 3) << 8) | b6)
 *     [7]  bits 0-4: power high bits · bit 5: peak-power display mode
 *          bits 6-7: power range (0=100W 1=250W 2=1000W 3=2500W)
 *     [8]  power low byte (watts; 13-bit: ((b7 & 0x1F) << 8) | b8)
 *     [9]  bits 0-1: VSWR high bits · upper bits: RF-present flags
 *     [10] VSWR low byte (VSWR = (((b9 & 3) << 8) | b10) / 100)
 *     [11] checksum — two's complement of the sum of bytes 0..10
 *
 *   Command frame — 4 bytes: 0x7A, mnemonic, value, checksum (same formula):
 *     mnemonic 0x31..0x33 ('1'..'3') = select antenna port (value 0x00)
 *     mnemonic 0x61 ('a') = AUTO mode   (value 0x00)
 *     mnemonic 0x62 ('b') = BYPASS mode (value 0x00)
 *     mnemonic 0x53/0x4C/0x56 ('S'/'L'/'V') = remote select/left/button-off
 *   MANUAL mode has no serial command — it is set on the front panel.
 *
 *   Set-frequency frame — 10 bytes:
 *     0x7A 0x74 0x00 0x00 + 5 ASCII digits (freq in Hz as "D8", first five
 *     digits = kHz zero-padded) + checksum over the first 9 bytes.
 *     The HF-AUTO Controller app brackets it with 'button off' (0x56) frames
 *     and sends the first frequency after connect twice (firmware quirk:
 *     the first one can recall wrong C/L values).
 */
const { SerialPort } = require('serialport');
const state = require('./state');

const FRAME_LEN = 12;
const STATUS_HEADER = 0x77;
const CMD_HEADER = 0x7a;
const MODE_NAMES = { 0: 'STARTUP', 1: 'AUTO', 2: 'MANUAL', 3: 'BYPASS', 4: 'SETUP' };
const POWER_RANGE = [100, 250, 1000, 2500];
const RF_HANGOVER_MS = 1500; // power dips (SSB/CW) shorter than this stay in the same TX session

let port = null;
let cfg = null;
let watchdog = null;
let lastData = 0;
let rxBuf = Buffer.alloc(0);
let lastFrameHex = '';
let lastFrameLog = 0;

// Peak power, held per TX session (reset when the next session starts)
let peakPower = 0;
let txActive = false;
let lastRfTime = 0;

// Frequency tracking from the radio
let lastSentKHz = 0;
let freqDebounce = null;
let firstFreqAfterConnect = true;

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
      firstFreqAfterConnect = true;
      lastSentKHz = 0;
      state.update('tuner', { connected: true });
      _startWatchdog();
    });
  } catch (err) {
    console.error('[tuner] start error:', err.message);
  }
}

function stop() {
  if (watchdog) clearInterval(watchdog);
  if (freqDebounce) clearTimeout(freqDebounce);
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

  const mode = MODE_NAMES[f[1]] || 'UNKNOWN';
  const patch = { connected: true, online: true, mode };

  // Operating data is only valid in AUTO / MANUAL / BYPASS. In STARTUP the
  // frequency bytes carry the firmware version; in SETUP they carry menu data.
  if (f[1] >= 1 && f[1] <= 3) {
    const power = ((f[7] & 0x1f) << 8) | f[8];
    const now = Date.now();

    // Peak power, held per TX session: reset when RF first appears, then keep
    // the session maximum on display through RX until the next TX starts.
    if (power > 0) {
      if (!txActive) { txActive = true; peakPower = 0; }
      if (power > peakPower) peakPower = power;
      lastRfTime = now;
    } else if (txActive && now - lastRfTime > RF_HANGOVER_MS) {
      txActive = false;
    }

    const antenna = (f[5] >> 2) & 0x03;
    patch.frequency = ((f[2] << 8) | f[3]) / 1000; // MHz
    patch.capacitance = f[4];
    patch.inductance = ((f[5] & 0x03) << 8) | f[6];
    patch.power = power;
    patch.peakPower = peakPower;
    patch.powerRangeLimit = POWER_RANGE[(f[7] >> 6) & 0x03];
    patch.swr = (((f[9] & 0x03) << 8) | f[10]) / 100;
    if (antenna >= 1 && antenna <= 3) patch.antenna = antenna;
  }

  state.update('tuner', patch);
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
function _write(frame) {
  if (!port || !port.isOpen) return false;
  port.write(frame, (err) => {
    if (err) console.warn('[tuner] write error:', err.message);
  });
  return true;
}

function _sendCmd(mnemonic, value = 0) {
  const frame = Buffer.from([CMD_HEADER, mnemonic, value, 0]);
  frame[3] = checksum(frame, 3);
  return _write(frame);
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

/**
 * Send the operating frequency so the tuner can recall stored C/L before TX.
 * Frame: 7A 74 00 00 + 5 ASCII digits of Hz zero-padded to 8 ("D8" → kHz) + checksum.
 */
function setFrequency(hz) {
  hz = Math.round(Number(hz));
  if (!hz || hz <= 0 || hz >= 60e6) return null;
  const t = state.get().tuner;
  // Don't poke the tuner while the user is in the front-panel setup menus.
  if (t.mode === 'SETUP' || t.mode === 'STARTUP') return null;

  const digits = String(hz).padStart(8, '0').slice(0, 5);
  const frame = Buffer.alloc(10);
  frame[0] = CMD_HEADER;
  frame[1] = 0x74; // 't'
  for (let i = 0; i < 5; i++) frame[4 + i] = digits.charCodeAt(i);
  frame[9] = checksum(frame, 9);

  // Mirror the HF-AUTO Controller app: bracket with 'button off' frames.
  _sendCmd(0x56);
  if (!_write(frame)) return null;
  _sendCmd(0x56);

  lastSentKHz = Math.floor(hz / 1000);

  // Firmware quirk: the first frequency sent after connecting can recall the
  // wrong C/L values, so repeat it once (the official app does the same).
  if (firstFreqAfterConnect) {
    firstFreqAfterConnect = false;
    setTimeout(() => { _sendCmd(0x56); _write(frame); _sendCmd(0x56); }, 400);
  }
  return hz;
}

/**
 * Called by the FlexRadio service whenever the active slice frequency changes.
 * Debounced (the VFO streams updates while spinning) and deduped at kHz
 * resolution so the tuner only hears real moves.
 */
function notifyFrequencyMHz(mhz) {
  const hz = Math.round(Number(mhz) * 1e6);
  if (!hz || hz <= 0) return;
  if (Math.floor(hz / 1000) === lastSentKHz) return;
  if (cfg && cfg.send_frequency === false) return;
  if (freqDebounce) clearTimeout(freqDebounce);
  freqDebounce = setTimeout(() => {
    const sent = setFrequency(hz);
    if (sent) console.log(`[tuner] frequency sent: ${(hz / 1e6).toFixed(3)} MHz`);
  }, 400);
}

module.exports = { start, stop, selectAntenna, setMode, setFrequency, notifyFrequencyMHz };
