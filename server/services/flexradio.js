/**
 * flexradio.js - FlexRadio 8600 (SmartSDR) integration.
 *
 * Connection model (matches the SmartSDR TCP/IP API used by the Node-RED
 * node-red-contrib-flexradio nodes):
 *   1. Discover the radio via VITA-49 broadcast on UDP 4992 (or connect to a
 *      manually configured host).
 *   2. Open a TCP command channel to port 4992 (newline-delimited protocol).
 *   3. Bind a local UDP socket for the realtime VITA-49 data/meter stream and
 *      tell the radio to send to it with `client udpport <port>`.
 *   4. Send subscriptions (`sub meter all`, `sub slice all`, ...). The radio
 *      then replies over TCP with meter DEFINITIONS (status messages) and
 *      streams meter VALUES as binary VITA-49 packets (class code 0x8002) on
 *      the UDP port.
 *
 * Meter handling:
 *   - Definitions arrive over TCP as: S<handle>|meter <id>.src=.. <id>.num=..
 *     <id>.nam=.. <id>.unit=.. ...   We build a map  meter_id -> {src,num,nam,unit}.
 *   - Values arrive over UDP as VITA-49 0x8002 packets containing (uint16 id,
 *     int16 raw) pairs. raw is scaled by the meter's unit:
 *         dBm / dBFS / SWR / dB  -> raw / 128
 *         Volts / Amps           -> raw / 1024
 *         degC / degF (degrees)  -> raw / 64
 *         RPM / Percent / other  -> raw (as-is)
 *   - The decoded topic `<src>/<num>/<nam>` is matched against the meter
 *     routing table (mirrors the Node-RED "Flex Meters" switch) and the value
 *     is written to state.flexradio.meters[<key>].
 */
const dgram = require('dgram');
const net = require('net');
const state = require('./state');
const tuner = require('./tuner');
const serial = require('./serial');

let cfg = null;
let discoverySock = null;
let meterSock = null;        // UDP socket that receives VITA-49 meter/data stream
let meterUdpPort = 0;        // local port the radio streams meters to
let tcpClient = null;
let watchdog = null;
let radioHost = null;
const meterDefs = {};        // meter_id -> { src, num, nam, unit, topic }

/**
 * Meter routing table - mirrors the Node-RED "Flex Meters" switch (10 meters).
 * Each decoded meter topic (`<src>/<num>/<nam>`) is tested in order; the first
 * matching rule maps the value into state.flexradio.meters[<key>].
 *   watts:true   -> value is in dBm, convert to Watts for display.
 */
const METER_ROUTES = [
  { re: /RAD\/[^/\n]+\/MAINFAN/i,   key: 'fan_rpm' },
  { re: /TX-\/3\/SWR/i,             key: 'swr' },
  { re: /TX-\/1\/FWDPWR/i,          key: 'fwd_power', watts: true },
  { re: /TX-\/[^/\n]+\/PATEMP/i,    key: 'pa_temp' },
  { re: /COD-\/[^/\n]+\/MICPEAK/i,  key: 'mic_peak' },
  { re: /COD-\/[^/\n]+\/COMPPEAK/i, key: 'comp_peak' },
  { re: /COD-\/[^/\n]+\/GAIN/i,     key: 'gain' },
  { re: /COD-\/[^/\n]+\/SC_MIC1/i,  key: 'sc_mic' },
  { re: /RAD\/300\/PACURRENT/i,     key: 'pa_current' },
  { re: /RAD\/334\/\+13\.8A/i,      key: 'pa_volts' }
];

function start(config) {
  cfg = config && config.flexradio;
  if (!cfg || !cfg.enabled) { console.log('[flex] disabled in config.'); return; }

  if (cfg.host_mode === 'manual' && cfg.host) {
    radioHost = cfg.host;
    console.log(`[flex] manual host mode -> ${radioHost}`);
    connectTCP(radioHost);
  } else {
    startDiscovery();
  }
  startWatchdog();
}

/** Listen for FlexRadio VITA-49 discovery packets on UDP 4992. */
function startDiscovery() {
  try {
    discoverySock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    discoverySock.on('message', (msg, rinfo) => {
      // Discovery payload contains the radio's IP; mark link alive.
      state.update('flexradio', { lastActivity: Date.now(), radioLinkOK: true });
      if (!radioHost) {
        radioHost = rinfo.address;
        console.log(`[flex] discovered radio at ${radioHost}`);
        connectTCP(radioHost);
      }
    });
    discoverySock.on('error', (e) => console.warn('[flex] discovery error:', e.message));
    discoverySock.bind(cfg.discovery_port || 4992, () => {
      console.log(`[flex] listening for discovery on ${cfg.discovery_port || 4992}`);
    });
  } catch (err) {
    console.warn('[flex] discovery failed:', err.message);
  }
}

/**
 * Bind the local UDP socket that receives the realtime VITA-49 meter/data
 * stream. Invokes cb(port) once bound so the caller can tell the radio which
 * port to stream to. Re-uses an already-bound socket.
 */
function setupMeterSocket(cb) {
  if (meterSock && meterUdpPort) { cb(meterUdpPort); return; }
  try {
    meterSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    meterSock.on('message', (msg) => {
      state.update('flexradio', { lastActivity: Date.now() });
      try { decodeVitaPacket(msg); }
      catch (e) { console.warn('[flex][meter] VITA decode error:', e.message); }
    });
    meterSock.on('error', (e) => console.warn('[flex][meter] UDP socket error:', e.message));
    meterSock.bind(0, () => {        // ephemeral port chosen by the OS
      meterUdpPort = meterSock.address().port;
      console.log(`[flex][meter] UDP meter stream socket bound on local port ${meterUdpPort}`);
      cb(meterUdpPort);
    });
  } catch (err) {
    console.warn('[flex][meter] failed to bind meter UDP socket:', err.message);
    cb(0);
  }
}

/**
 * Connect to the radio's TCP command port (4992). Newline-delimited protocol.
 * On connect we bind the UDP meter socket, register it with the radio, and
 * send the configured subscriptions.
 */
function connectTCP(host) {
  try {
    tcpClient = net.createConnection({ host, port: cfg.tcp_port || 4992 }, () => {
      console.log(`[flex] TCP connected to ${host}:${cfg.tcp_port || 4992}`);
      state.update('flexradio', { connected: true, radioLinkOK: true, lastActivity: Date.now() });

      // Bind the meter UDP socket, register it, then subscribe.
      setupMeterSocket((port) => {
        if (port) {
          console.log(`[flex] registering UDP meter port with radio: client udpport ${port}`);
          sendCommand(`client udpport ${port}`);
        } else {
          console.warn('[flex] no UDP meter port available - meter values will not stream.');
        }
        const subs = cfg.subscriptions || [];
        console.log(`[flex] sending ${subs.length} subscription command(s): ${subs.join(', ')}`);
        subs.forEach((sub) => {
          sendCommand(sub.replace('{Client_ID}', state.get().flexradio.clientName || '0'));
        });
        console.log('[flex] meter subscription active (sub meter all) - awaiting meter definitions + values.');
      });
    });
    let buf = '';
    tcpClient.on('data', (data) => {
      state.update('flexradio', { lastActivity: Date.now() });
      buf += data.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) handleLine(line);
      }
    });
    tcpClient.on('error', (e) => console.warn('[flex] tcp error:', e.message));
    tcpClient.on('close', () => {
      console.warn('[flex] TCP connection closed - will retry in 5s.');
      state.update('flexradio', { connected: false });
      tcpClient = null;
      setTimeout(() => { if (radioHost) connectTCP(radioHost); }, 5000);
    });
  } catch (err) {
    console.warn('[flex] tcp connect failed:', err.message);
  }
}

let cmdSeq = 1;
function sendCommand(cmd) {
  if (tcpClient && !tcpClient.destroyed) {
    tcpClient.write(`C${cmdSeq++}|${cmd}\n`);
  }
}

/**
 * Parse a status/meter line from the TCP command stream.
 *   S<handle>|slice 0 RF_frequency=14.250 mode=USB active=1
 *   S<handle>|meter 1.src=COD- 1.num=1 1.nam=MICPEAK 1.unit=dBFS ...
 *   S<handle>|transmit state=TRANSMITTING
 *   S<handle>|... apd enable=1
 */
function handleLine(line) {
  // Meter definitions (build the meter_id -> metadata map).
  if (/\|meter\s/i.test(line) || /^meter\s/i.test(line)) {
    parseMeterDefs(line);
    return;
  }
  // Slice updates
  const sliceMatch = line.match(/slice (\d+) (.+)/);
  if (sliceMatch) {
    const idx = parseInt(sliceMatch[1], 10);
    const key = ['A', 'B', 'C', 'D'][idx];
    if (key) {
      const props = parseKeyVals(sliceMatch[2]);
      const patch = {};
      if (props.RF_frequency) patch.freq = parseFloat(props.RF_frequency);
      if (props.mode) patch.mode = props.mode;
      if (props.active !== undefined) patch.active = parseInt(props.active, 10);
      if (props.filter_lo !== undefined) patch.filter_lo = parseFloat(props.filter_lo);
      if (props.filter_hi !== undefined) patch.filter_hi = parseFloat(props.filter_hi);
      state.update('flexradio', { slices: { [key]: patch } });
      if (props.active === '1') state.update('flexradio', { activeSlice: key });
      // Track the active slice on the HF-Auto tuner so it can recall stored
      // C/L for the new frequency before we ever transmit there.
      const fr = state.get().flexradio;
      if (key === fr.activeSlice) {
        const freq = patch.freq !== undefined ? patch.freq : (fr.slices[key] && fr.slices[key].freq);
        if (freq) {
          tuner.notifyFrequencyMHz(freq);
          // Pre-feed the amp too so it can pre-select its band filter before TX.
          serial.notifyFrequencyMHz(freq);
        }
      }
    }
    return;
  }
  // TX status object. The radio emits two `transmit` lines on subscribe; the
  // detailed one carries the TX audio passband (and `state=` arrives on PTT
  // changes), so handle any `transmit ` line and pick out whatever is present.
  if (/(^|\|)transmit\s/i.test(line)) {
    const txProps = parseHashKeyVals(line);
    const txPatch = {};
    if (txProps.state) txPatch.txStatus = txProps.state.toUpperCase();
    // The transmit status object reports the TX audio passband as bare
    // `lo`/`hi` (Hz), e.g. `... lo=50 hi=3000 tx_filter_changes_allowed=1 ...`.
    if (txProps.lo !== undefined) txPatch.tx_filter_lo = parseFloat(txProps.lo);
    if (txProps.hi !== undefined) txPatch.tx_filter_hi = parseFloat(txProps.hi);
    if (Object.keys(txPatch).length) state.update('flexradio', txPatch);
    return;
  }
  // APD (Adaptive Pre-Distortion). Capture every field the radio sends so the
  // UI can show Off / Calibrating / Calibrated. The exact field that signals
  // the calibration phase is confirmed via the [flex][apd][raw] log below.
  if (/\bapd\b/i.test(line) && /\benable=/i.test(line)) {
    console.log('[flex][apd][raw] ' + line);   // TEMP: confirm calibrating/calibrated fields
    const apdStr = line.replace(/^.*?\bapd\b\s*/i, '');
    const props = parseHashKeyVals(apdStr);
    const patch = {};
    for (const [k, v] of Object.entries(props)) {
      patch[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    if (Object.keys(patch).length) state.update('flexradio', { apd: patch });
  }
}

/**
 * Parse a meter definition status line into meterDefs. A line can define many
 * meters; fields look like `<id>.src=`, `<id>.num=`, `<id>.nam=`, `<id>.unit=`.
 */
function parseMeterDefs(line) {
  // Fields are `<id>.<field>=<value>` and may be delimited by whitespace AND/OR
  // '#' (this firmware packs a meter's fields together with '#' separators, e.g.
  // `1.src=COD-#1.num=1#1.nam=MICPEAK#1.unit=dBFS#1.fps=40#`). Match each
  // field directly, stopping the value at the next space or '#'.
  const re = /(\d+)\.(\w+)=([^\s#]*)/g;
  const touched = new Set();
  let m;
  while ((m = re.exec(line)) !== null) {
    const id = m[1];
    const field = m[2].toLowerCase();
    const value = m[3];
    if (!meterDefs[id]) meterDefs[id] = {};
    meterDefs[id][field] = value;
    touched.add(id);
  }
  touched.forEach((id) => {
    const d = meterDefs[id];
    if (d.src && d.num !== undefined && d.nam) {
      d.topic = `${d.src}/${d.num}/${d.nam}`;
    }
    console.log(`[flex][meter] definition: id=${id} topic=${d.topic || '(incomplete)'} unit=${d.unit || '?'}`);
  });
}

function parseKeyVals(str) {
  const out = {};
  str.split(/\s+/).forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  });
  return out;
}

/** Like parseKeyVals but tolerant of both whitespace and '#' field delimiters. */
function parseHashKeyVals(str) {
  const out = {};
  const re = /([A-Za-z_]\w*)=([^\s#]*)/g;
  let m;
  while ((m = re.exec(str)) !== null) out[m[1]] = m[2];
  return out;
}

/** dBm -> Watts conversion used for the forward power meter. */
function dbmToWatts(dbm) {
  return Math.pow(10, (dbm - 30) / 10);
}

/** Scale a raw int16 meter sample using the meter's unit (FlexLib rules). */
function scaleMeter(raw, unit) {
  const u = (unit || '').toLowerCase();
  if (u.includes('dbm') || u.includes('dbfs') || u === 'swr' || u === 'db') return raw / 128;
  if (u.includes('volt') || u.includes('amp')) return raw / 1024;
  if (u.includes('deg')) return raw / 64;            // degC / degF
  if (u.includes('rpm') || u.includes('percent')) return raw;
  return raw / 128;                                  // sensible default for dB-like meters
}

/**
 * Decode a VITA-49 packet. We only care about FlexRadio meter packets
 * (packet class code 0x8002); everything else (panadapter/waterfall/audio)
 * is ignored. Header flags are parsed to locate the payload robustly.
 */
function decodeVitaPacket(buf) {
  if (!buf || buf.length < 8) return;
  const header = buf.readUInt32BE(0);
  const ptype = (header >>> 28) & 0xF;     // packet type
  const hasClass = (header >>> 27) & 0x1;  // C: class id present
  const hasTrailer = (header >>> 26) & 0x1;// T: trailer present
  const tsi = (header >>> 22) & 0x3;       // integer timestamp present
  const tsf = (header >>> 20) & 0x3;       // fractional timestamp present
  const sizeWords = header & 0xFFFF;       // total packet size in 32-bit words

  let off = 4;
  // Packet types with a Stream Identifier: 1 (IF data), 3 (ext data), 4/5 (context)
  if (ptype === 1 || ptype === 3 || ptype === 4 || ptype === 5) off += 4;

  let classCode = null;
  if (hasClass) {
    if (off + 8 > buf.length) return;
    classCode = buf.readUInt32BE(off + 4) & 0xFFFF; // packet class code = low 16 bits of 2nd class word
    off += 8;
  }
  if (tsi) off += 4;
  if (tsf) off += 8;

  if (classCode !== 0x8002) return;        // not a meter packet

  let end = sizeWords > 0 ? Math.min(buf.length, sizeWords * 4) : buf.length;
  if (hasTrailer) end -= 4;                // drop the trailer word

  decodeMeterPayload(buf, off, end);
}

/** Decode (uint16 id, int16 raw) pairs and route them into state. */
function decodeMeterPayload(buf, start, end) {
  let count = 0;
  for (let p = start; p + 4 <= end; p += 4) {
    const id = buf.readUInt16BE(p);
    const raw = buf.readInt16BE(p + 2);
    const def = meterDefs[id];
    if (!def) {
      // Value before its definition arrived - skip (logged only in debug mode
      // to avoid flooding the log ring buffer at the meter stream rate).
      if (cfg && cfg.debug_meters) {
        console.log(`[flex][meter] value for unknown meter id=${id} raw=${raw} (definition not received yet)`);
      }
      continue;
    }
    const topic = def.topic || `${def.src}/${def.num}/${def.nam}`;
    const value = scaleMeter(raw, def.unit);
    applyMeterValue(topic, value, def, raw);
    count++;
  }
  if (count) state.update('flexradio', { lastActivity: Date.now() });
}

/**
 * Match a decoded meter topic against the routing table and store the value
 * into state.flexradio.meters[<key>]. Mirrors the Node-RED "Flex Meters" switch.
 */
function applyMeterValue(topic, value, def, raw) {
  const route = METER_ROUTES.find((r) => r.re.test(topic));
  if (!route) return;                       // not one of the 10 displayed meters
  let out = value;
  if (route.watts) out = dbmToWatts(value); // FWDPWR: dBm -> Watts
  out = Math.round(out * 100) / 100;        // 2-decimal precision
  state.update('flexradio', { meters: { [route.key]: out } });
  // Routine per-sample meter logging is very high rate (audio meters update
  // ~30x/sec) and would swamp the log ring buffer, so gate it behind a flag.
  if (cfg && cfg.debug_meters) {
    console.log(`[flex][meter] ${route.key} <- ${out} (topic=${topic}, raw=${raw}, unit=${def.unit || '?'}${route.watts ? ', dBm=' + (Math.round(value * 100) / 100) : ''})`);
  }
}

function startWatchdog() {
  if (watchdog) clearInterval(watchdog);
  const interval = (cfg.watchdog_interval_sec || 5) * 1000;
  const stale = cfg.staleness_timeout_ms || 15000;
  watchdog = setInterval(() => {
    const f = state.get().flexradio;
    if (f.lastActivity && Date.now() - f.lastActivity > stale) {
      state.update('flexradio', { radioLinkOK: false });
    }
  }, interval);
}

/* ---- Control API ---- */
function setRfPower(percent) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  sendCommand(`transmit set rfpower=${p}`);
  state.update('flexradio', { rfpower: p });
  return p;
}

function toggleApd(enable) {
  sendCommand(`apd enable=${enable ? 1 : 0}`);
  state.update('flexradio', { apd: { enable: enable ? 1 : 0 } });
  return enable;
}

/**
 * Apply amp RF-power-limiting rules (from automation extracted in Node-RED).
 * Called when the amp operate/standby mode changes.
 */
function applyAmpRfRule(ampMode) {
  if (!cfg.amp_integration) return;
  const ai = cfg.amp_integration;
  if (ampMode === 'operate') {
    setRfPower(ai.amp_on_rf_power);
  } else {
    setRfPower(ai.amp_off_rf_power);
  }
}

function stop() {
  if (watchdog) clearInterval(watchdog);
  if (discoverySock) try { discoverySock.close(); } catch {}
  if (meterSock) try { meterSock.close(); } catch {}
  if (tcpClient) try { tcpClient.destroy(); } catch {}
  meterSock = null;
  meterUdpPort = 0;
}

module.exports = {
  start, stop, setRfPower, toggleApd, applyAmpRfRule, dbmToWatts,
  // exported for testing
  parseMeterDefs, decodeVitaPacket, scaleMeter, applyMeterValue, _meterDefs: meterDefs
};
