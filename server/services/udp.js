/**
 * udp.js - Palstar HF-Auto tuner control over UDP.
 *
 * Rotator control has been moved to server/services/rotator.js (direct serial
 * to the EA4TX ERC-Mini, bypassing PST Rotator).
 *
 * Tuner: listen 13080, send 127.0.0.1:12020 (broadcast), full XML.
 * A watchdog marks the tuner offline if no data arrives within the timeout.
 */
const dgram = require('dgram');
const state = require('./state');

let tunCfg = null;
let tunSock = null;
let tunWatchdog = null;
let tunLastData = 0;

function start(config) {
  const udp = config && config.udp;
  if (!udp) return;
  tunCfg = udp.palstar_hf_auto_tuner;
  if (tunCfg && tunCfg.enabled) startTuner();
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
  if (tunWatchdog) clearInterval(tunWatchdog);
  if (tunSock) try { tunSock.close(); } catch {}
}

module.exports = { start, stop, tunerSelectAntenna, tunerSetMode };
