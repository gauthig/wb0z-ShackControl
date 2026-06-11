/**
 * rotator.js - Direct serial control of the Yaesu G-800DXA via EA4TX ERC-Mini.
 *
 * Replaces the PST Rotator UDP bridge. Speaks Yaesu GS-232A directly on the
 * COM port that the ERC-Mini listens on (default COM5, 9600 8N1).
 *
 * Protocol summary:
 *   C2\r\n        → +0XXX\r\n   query current azimuth (3-digit zero-padded)
 *   Maaa\r\n      → (silent)    go to azimuth aaa — controller picks shortest path
 *   R\r\n         → (silent)    rotate CW continuously
 *   L\r\n         → (silent)    rotate CCW continuously
 *   A\r\n         → (silent)    stop all movement
 */
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const state = require('./state');

let port = null;
let cfg = null;
let pollTimer = null;
let jogWatchdog = null;
let jogging = false;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
function start(config) {
  cfg = config && config.serial && config.serial.erc_mini_rotator;
  if (!cfg || !cfg.enabled) return;

  try {
    port = new SerialPort({
      path: cfg.serial_port || 'COM5',
      baudRate: Number(cfg.baud_rate) || 9600,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      autoOpen: false
    });

    // GS-232A terminates lines with CR only (\r), not CRLF.
    const parser = port.pipe(new ReadlineParser({ delimiter: '\r' }));

    parser.on('data', (line) => {
      const trimmed = line.trim();
      if (trimmed) console.log('[rotator] rx:', JSON.stringify(trimmed));
      // ERC-Mini sends GS-232B format: "AZ=071  EL=000"
      // Fall back to GS-232A format "+0XXX" just in case firmware differs.
      const m = trimmed.match(/AZ=(\d+)/i) || trimmed.match(/\+0(\d{3})/);
      if (!m) return;
      const az = parseInt(m[1], 10);
      if (isNaN(az)) return;
      state.update('rotator', { azimuth: az, connected: true });
      // Hard-stop if a jog reaches a boundary
      if (jogging && (az <= 0 || az >= 360)) {
        _sendCmd('A');
        jogging = false;
        state.update('rotator', { moving: false });
      }
    });

    port.on('error', (err) => {
      console.error('[rotator] serial error:', err.message);
      state.update('rotator', { connected: false });
    });

    port.on('close', () => {
      console.warn('[rotator] port closed');
      state.update('rotator', { connected: false, moving: false });
    });

    port.open((err) => {
      if (err) {
        console.error('[rotator] cannot open', cfg.serial_port, '-', err.message);
        state.update('rotator', { connected: false });
        return;
      }
      console.log(`[rotator] ${cfg.serial_port} opened at ${cfg.baud_rate || 9600} baud`);
      state.update('rotator', { connected: true });
      _startPoll();
    });
  } catch (err) {
    console.error('[rotator] start error:', err.message);
  }
}

function stop() {
  if (pollTimer) clearInterval(pollTimer);
  _clearWatchdog();
  if (port && port.isOpen) try { port.close(); } catch {}
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function _sendCmd(cmd) {
  if (!port || !port.isOpen) return;
  port.write(cmd + '\r\n', (err) => {
    if (err) console.warn('[rotator] write error:', err.message);
  });
}

function _startPoll() {
  if (pollTimer) clearInterval(pollTimer);
  _sendCmd('C2');
  pollTimer = setInterval(() => _sendCmd('C2'), 2000);
}

/** Go to a specific azimuth. The ERC-Mini chooses the shortest rotation path. */
function setAzimuth(degrees) {
  const d = Math.max(0, Math.min(360, Math.round(degrees)));
  _sendCmd('M' + String(d).padStart(3, '0'));
  state.update('rotator', { target: d, moving: true });
  return d;
}

/**
 * Start a manual jog in the given direction ('cw' or 'ccw').
 * Each call resets the 2-second safety watchdog — if the client stops
 * sending heartbeats (e.g. browser closes) the rotator auto-stops.
 */
function jog(dir) {
  // ERC-Mini does not support R/L continuous-rotation commands.
  // Use M (go-to heading) to drive to the respective limit instead;
  // stopRotator() sends A to halt mid-sweep.
  if (dir === 'cw') {
    _sendCmd('M359');
    state.update('rotator', { target: 359, moving: true });
  } else if (dir === 'ccw') {
    _sendCmd('M001');
    state.update('rotator', { target: 1, moving: true });
  }
  jogging = true;
}

/** Stop all rotation immediately. */
function stopRotator() {
  jogging = false;
  _clearWatchdog();
  _sendCmd('A');
  state.update('rotator', { moving: false, target: null });
}

// ---------------------------------------------------------------------------
// Watchdog — auto-stop if no jog heartbeat within 2 s
// ---------------------------------------------------------------------------
function _resetWatchdog() {
  _clearWatchdog();
  jogWatchdog = setTimeout(() => {
    if (jogging) {
      console.log('[rotator] jog watchdog fired — auto-stop');
      stopRotator();
    }
  }, 2000);
}

function _clearWatchdog() {
  if (jogWatchdog) { clearTimeout(jogWatchdog); jogWatchdog = null; }
}

module.exports = { start, stop, setAzimuth, jog, stopRotator };
