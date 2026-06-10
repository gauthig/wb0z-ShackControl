/**
 * udp.js - PST Rotator and Palstar HF-Auto tuner control over UDP.
 *
 * Uses Node's built-in `dgram`. Two independent sockets:
 *   - PST Rotator: listen 12001, send 127.0.0.1:12000, simple <PST> XML.
 *   - HF-Auto Tuner: listen 13080, send 127.0.0.1:12020 (broadcast), full XML.
 *
 * A watchdog marks the tuner offline if no data arrives within the timeout.
 */
const dgram = require('dgram');
const state = require('./state');

let rotCfg = null;
let tunCfg = null;
let rotSock = null;
let tunSock = null;
let rotPollTimer = null;
let tunWatchdog = null;
let tunLastData = 0;

function start(config) {
  const udp = config && config.udp;
  if (!udp) return;
  rotCfg = udp.pst_rotator;
  tunCfg = udp.palstar_hf_auto_tuner;
  if (rotCfg && rotCfg.enabled) startRotator();
  if (tunCfg && tunCfg.enabled) startTuner();
}

/* ----------------- PST Rotator ----------------- */
function startRotator() {
  try {
    rotSock = dgram.createSocket(rotCfg.protocol || 'udp4');
    rotSock.on('message', (msg) => {
      const text = msg.toString('utf8').trim();
      // Response like "AZ:123" -> extract 3 chars from index 3
      if (text.startsWith('AZ')) {
        const az = parseInt(text.substring(3, 6), 10);
        if (!isNaN(az)) {
          state.update('rotator', { azimuth: az, connected: true, moving: false });
        }
      }
    });
    rotSock.on('error', (e) => console.warn('[udp:rotator] error:', e.message));
    rotSock.bind(rotCfg.listen_port, () => {
      console.log(`[udp:rotator] listening on ${rotCfg.listen_port}`);
      state.update('rotator', { connected: true });
      startRotatorPoll();
    });
  } catch (err) {
    console.warn('[udp:rotator] failed:', err.message);
  }
}

function startRotatorPoll() {
  if (rotPollTimer) clearInterval(rotPollTimer);
  const interval = (rotCfg.poll_interval_sec || 10) * 1000;
  const poll = () => sendRotator(rotCfg.poll_command);
  poll();
  rotPollTimer = setInterval(poll, interval);
}

function sendRotator(message) {
  if (!rotSock) return;
  const buf = Buffer.from(message, 'utf8');
  rotSock.send(buf, 0, buf.length, rotCfg.send_port, rotCfg.send_address);
}

function setAzimuth(degrees) {
  const d = Math.max(0, Math.min(360, Math.round(degrees)));
  if (rotCfg && rotCfg.set_azimuth_command) {
    sendRotator(rotCfg.set_azimuth_command.replace('{degrees}', String(d)));
  }
  state.update('rotator', { target: d, moving: true });
  return d;
}

function stopRotator() {
  if (rotCfg && rotCfg.stop_command) sendRotator(rotCfg.stop_command);
  state.update('rotator', { moving: false });
}

/* ----------------- HF-Auto Tuner ----------------- */
function startTuner() {
  try {
    tunSock = dgram.createSocket(tunCfg.protocol || 'udp4');
    tunSock.on('message', (msg) => {
      tunLastData = Date.now();
      parseTunerXML(msg.toString('utf8'));
      state.update('tuner', { connected: true, online: true });
    });
    tunSock.on('error', (e) => console.warn('[udp:tuner] error:', e.message));
    tunSock.bind(tunCfg.listen_port, () => {
      console.log(`[udp:tuner] listening on ${tunCfg.listen_port}`);
      if (tunCfg.broadcast) { try { tunSock.setBroadcast(true); } catch {} }
      startTunerWatchdog();
    });
  } catch (err) {
    console.warn('[udp:tuner] failed:', err.message);
  }
}

function xmlVal(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

function parseTunerXML(xml) {
  const pwrMax = xmlVal(xml, 'ATU_PWR_MAX');
  const pwr = xmlVal(xml, 'ATU_PWR');
  const swr = xmlVal(xml, 'ATU_SWR');
  const mode = xmlVal(xml, 'ATU_OPER_MODE');
  const ant = xmlVal(xml, 'ATU_ANT_NR');
  const patch = {};
  if (pwrMax !== null) patch.peakPower = parseFloat(pwrMax) || 0;
  if (pwr !== null) patch.power = parseFloat(pwr) || 0;
  if (swr !== null) patch.swr = parseFloat(swr) || 0;
  if (mode !== null) patch.mode = mode;
  if (ant !== null) patch.antenna = parseInt(ant, 10) || 1;
  if (Object.keys(patch).length) state.update('tuner', patch);
}

function startTunerWatchdog() {
  if (tunWatchdog) clearInterval(tunWatchdog);
  const timeout = (tunCfg.watchdog_timeout_sec || 20) * 1000;
  tunWatchdog = setInterval(() => {
    if (Date.now() - tunLastData > timeout) {
      state.update('tuner', { online: false });
    }
  }, 5000);
}

function sendTuner(message) {
  if (!tunSock) return;
  const buf = Buffer.from(message, 'utf8');
  tunSock.send(buf, 0, buf.length, tunCfg.send_port, tunCfg.send_address);
}

function tunerSelectAntenna(n) {
  const cmd = tunCfg && tunCfg.commands && tunCfg.commands[`select_antenna_${n}`];
  if (cmd) sendTuner(cmd);
  state.update('tuner', { antenna: Number(n) });
  // Apply antenna -> mode rule (resonant => bypass, else auto)
  const rule = tunCfg && tunCfg.antenna_rules && tunCfg.antenna_rules[String(n)];
  if (rule && rule.force_mode) {
    setTimeout(() => tunerSetMode(rule.force_mode), 800);
  }
  return n;
}

function tunerSetMode(mode) {
  const key = `mode_${String(mode).toLowerCase()}`;
  const cmd = tunCfg && tunCfg.commands && tunCfg.commands[key];
  if (cmd) sendTuner(cmd);
  state.update('tuner', { mode: String(mode).toUpperCase() });
  return mode;
}

function stop() {
  if (rotPollTimer) clearInterval(rotPollTimer);
  if (tunWatchdog) clearInterval(tunWatchdog);
  if (rotSock) try { rotSock.close(); } catch {}
  if (tunSock) try { tunSock.close(); } catch {}
}

module.exports = {
  start,
  stop,
  setAzimuth,
  stopRotator,
  tunerSelectAntenna,
  tunerSetMode
};
