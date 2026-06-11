/* dashboard.js - auth guard, live state rendering, controls, tabs. */
(function () {
  if (!API.getToken()) { location.href = '/'; return; }

  const user = API.getUser() || {};
  const canControl = user.role === 'admin' || user.role === 'normal';
  let publicCfg = { rotator_presets: [], tuner_antennas: {}, amp_integration: {} };
  let state = {};

  /* ---------- Header ---------- */
  document.getElementById('userName').textContent = user.displayName || user.username;
  document.getElementById('roleBadge').textContent = user.role || '';
  if (user.role === 'admin') {
    document.getElementById('usersTab').style.display = '';
    document.getElementById('settingsTab').style.display = '';
  }

  document.getElementById('logoutBtn').onclick = () => { API.clearToken(); location.href = '/'; };

  /* ---------- Disable controls for view-only ---------- */
  function applyPermissions() {
    if (!canControl) {
      document.querySelectorAll('.ctl').forEach((el) => { el.disabled = true; });
      document.querySelectorAll('[data-vo]').forEach((el) => el.classList.remove('hidden'));
    }
  }

  /* ---------- Tabs ---------- */
  document.querySelectorAll('.nav-tabs button').forEach((b) => {
    // Skip buttons that are plain navigation links (e.g. Settings -> /settings).
    // These have their own onclick/href and no in-page tab pane to show.
    if (!b.dataset.tab) return;
    b.onclick = () => {
      document.querySelectorAll('.nav-tabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.add('hidden'));
      const pane = document.getElementById('tab-' + b.dataset.tab);
      if (pane) pane.classList.remove('hidden');
    };
  });

  /* ---------- Load public config & build dynamic UI ---------- */
  async function loadConfig() {
    try { publicCfg = await API.get('/api/config/public'); } catch {}
    document.getElementById('siteName').textContent = publicCfg.site_name || 'Shack Control';
    if (publicCfg.callsign) document.getElementById('callsign').textContent = publicCfg.callsign;

    // Rotator presets
    const sel = document.getElementById('rotPreset');
    sel.innerHTML = '<option value="">— select heading —</option>';
    (publicCfg.rotator_presets || []).forEach((p) => {
      const o = document.createElement('option');
      o.value = p.value; o.textContent = `${p.label} (${p.value}°)`;
      sel.appendChild(o);
    });

    // Tuner antennas (with names from rules)
    const tg = document.getElementById('tunAntGroup');
    tg.innerHTML = '';
    const rules = publicCfg.tuner_antennas || {};
    for (let n = 1; n <= 3; n++) {
      const btn = document.createElement('button');
      btn.className = 'ctl';
      btn.dataset.act = 'tunant'; btn.dataset.ant = n;
      const nm = rules[n] && rules[n].name ? rules[n].name : 'Ant ' + n;
      btn.textContent = `${n}: ${nm}`;
      tg.appendChild(btn);
    }

    // Slice cards A-D
    const sr = document.getElementById('sliceRow');
    sr.innerHTML = '';
    ['A', 'B', 'C', 'D'].forEach((s) => {
      const div = document.createElement('div');
      div.style.cssText = 'border:1px solid var(--border);border-radius:10px;padding:12px;background:var(--surface2)';
      div.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
          <b>Slice ${s}</b><span class="tag off" id="sl_${s}_act">IDLE</span></div>
        <div class="kv"><span class="k">Freq</span><span class="v" id="sl_${s}_freq">—</span></div>
        <div class="kv"><span class="k">Mode</span><span class="v" id="sl_${s}_mode">—</span></div>`;
      sr.appendChild(div);
    });

    applyPermissions();
  }

  /* ---------- Gauge helper ---------- */
  function setGauge(fillId, valId, value, max, decimals) {
    const v = Number(value) || 0;
    const pct = Math.max(0, Math.min(100, (v / (max || 100)) * 100));
    const f = document.getElementById(fillId);
    if (f) f.style.width = pct + '%';
    const t = document.getElementById(valId);
    if (t) t.textContent = decimals ? v.toFixed(decimals) : Math.round(v);
  }
  function setText(id, val) { const e = document.getElementById(id); if (e) e.textContent = (val ?? '—'); }
  function setTag(id, on, onText, offText) {
    const e = document.getElementById(id);
    if (!e) return;
    e.className = 'tag ' + (on ? 'on' : 'off');
    e.textContent = on ? (onText || 'ON') : (offText || 'OFF');
  }
  function fmtFreq(mhz) {
    if (!mhz) return '—';
    return Number(mhz).toFixed(3) + ' MHz';
  }

  /* Home Assistant sync status indicator (in the Power card header). */
  let pendingPower = 0; // count of in-flight toggle commands
  function renderHaSync(ha) {
    const tag = document.getElementById('haSyncTag');
    const note = document.getElementById('haSyncNote');
    if (!tag) return;
    if (!ha.enabled) {
      tag.className = 'tag off'; tag.textContent = 'HA OFF';
      if (note) note.textContent = 'Home Assistant not configured — power states are local only.';
      return;
    }
    if (ha.syncing || pendingPower > 0) {
      tag.className = 'tag warn'; tag.textContent = 'SYNCING…';
      if (note) note.textContent = 'Synchronizing with Home Assistant…';
      return;
    }
    if (ha.lastError) {
      tag.className = 'tag off'; tag.textContent = 'HA ERROR';
      if (note) note.textContent = 'HA sync error: ' + ha.lastError;
      return;
    }
    tag.className = 'tag on'; tag.textContent = 'HA SYNCED';
    if (note) {
      const when = ha.lastSync ? new Date(ha.lastSync).toLocaleTimeString() : '—';
      note.textContent = 'Live from Home Assistant · last sync ' + when;
    }
  }

  /* ---------- Render full state ---------- */
  function render() {
    const s = state;
    if (!s || !s.power) return;
    // Power
    setTag('psTag', s.power.powerSupply);
    setTag('radioTag', s.power.radioPower);
    setTag('ampPwrTag', s.power.ampPower);
    renderHaSync(s.home_assistant || {});

    // FlexRadio slices (FlexRadio panel removed; slice strip retained)
    const f = s.flexradio || {};
    ['A', 'B', 'C', 'D'].forEach((k) => {
      const sl = (f.slices && f.slices[k]) || {};
      setText('sl_' + k + '_freq', fmtFreq(sl.freq));
      setText('sl_' + k + '_mode', sl.mode || '—');
      setTag('sl_' + k + '_act', sl.active === 1 || sl.active === '1', 'ACTIVE', 'IDLE');
    });

    // Rotator
    const r = s.rotator || {};
    document.getElementById('azReadout').textContent = Math.round(r.azimuth || 0);
    document.getElementById('needle').setAttribute('transform', `rotate(${r.azimuth || 0} 100 100)`);
    setTag('rotConn', r.connected, 'ONLINE', 'OFFLINE');

    // Amp
    const a = s.amp || {};
    setTag('ampConn', a.connected, 'ONLINE', 'OFFLINE');
    const ampMode = document.getElementById('ampMode');
    ampMode.className = 'tag ' + (a.mode === 'operate' ? 'on' : 'off');
    ampMode.textContent = (a.mode || 'standby').toUpperCase();
    setText('ampFreq', a.frequency ? a.frequency.toFixed(3) + ' MHz' : '—');
    setText('ampBand', a.band || '—');
    setText('ampKey', a.keyStatus || 'Unkeyed');
    setGauge('gf_ampfwd', 'g_ampfwd', a.fwdPower, 1500);
    setGauge('gf_amptemp', 'g_amptemp', a.temperature, 100);
    highlight('ampAntGroup', 'ant', a.antenna);
    document.getElementById('ampOperateBtn').classList.toggle('active', a.mode === 'operate');
    document.getElementById('ampStandbyBtn').classList.toggle('active', a.mode !== 'operate');

    // Tuner
    const t = s.tuner || {};
    setTag('tunConn', t.online, 'ONLINE', 'OFFLINE');
    setGauge('gf_tswr', 'g_tswr', t.swr, 10, 1);
    setGauge('gf_tpwr', 'g_tpwr', t.power, 1500);
    setGauge('gf_tpeak', 'g_tpeak', t.peakPower, 1500);
    highlight('tunModeGroup', 'mode', t.mode, true);
    highlight('tunAntGroup', 'ant', t.antenna);
  }

  function highlight(groupId, attr, value, isText) {
    const grp = document.getElementById(groupId);
    if (!grp) return;
    grp.querySelectorAll('button').forEach((b) => {
      const v = b.dataset[attr];
      const match = isText ? (String(v).toUpperCase() === String(value).toUpperCase())
                           : (Number(v) === Number(value));
      b.classList.toggle('active', match);
    });
  }

  /* ---------- WebSocket ---------- */
  let ws;
  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${API.getToken()}`);
    ws.onopen = () => setWs(true);
    ws.onclose = () => { setWs(false); setTimeout(connectWS, 3000); };
    ws.onerror = () => setWs(false);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') { state = msg.data; render(); }
      else if (msg.type === 'update') { mergeUpdate(msg.section, msg.partial); render(); }
    };
  }
  function setWs(ok) {
    document.getElementById('wsDot').classList.toggle('ok', ok);
    document.getElementById('wsState').textContent = ok ? 'live' : 'reconnecting…';
  }
  function mergeUpdate(section, partial) {
    if (!state[section]) state[section] = {};
    deepMerge(state[section], partial);
  }
  function deepMerge(t, s) {
    for (const k of Object.keys(s)) {
      if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) {
        if (!t[k] || typeof t[k] !== 'object') t[k] = {};
        deepMerge(t[k], s[k]);
      } else t[k] = s[k];
    }
  }

  /* ---------- Control actions ---------- */
  document.body.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled || !canControl) return;
    const act = el.dataset.act;
    try {
      if (act === 'power') {
        const map = { supply: 'powerSupply', radio: 'radioPower', amp: 'ampPower' };
        const stateKey = map[el.dataset.dev];
        const cur = state.power[stateKey];
        // Show syncing feedback while the command + HA confirmation round-trips.
        pendingPower++;
        el.disabled = true;
        const prevLabel = el.textContent;
        el.textContent = 'Syncing…';
        renderHaSync(state.home_assistant || {});
        try {
          const res = await API.post('/api/devices/power/' + el.dataset.dev, { on: !cur });
          // Apply the confirmed/actual state immediately (WS will also push it).
          if (res && typeof res[stateKey] === 'boolean') {
            mergeUpdate('power', { [stateKey]: res[stateKey] });
          }
        } finally {
          pendingPower = Math.max(0, pendingPower - 1);
          el.disabled = false;
          el.textContent = prevLabel;
          render();
        }
      } else if (act === 'ampmode') {
        await API.post('/api/devices/amp/mode', { mode: el.dataset.mode });
      } else if (act === 'ampant') {
        await API.post('/api/devices/amp/antenna', { antenna: Number(el.dataset.ant) });
      } else if (act === 'rotset') {
        const raw = Number(document.getElementById('azInput').value);
        const clamped = Math.max(0, Math.min(360, Math.round(raw)));
        document.getElementById('azInput').value = clamped;
        await API.post('/api/devices/rotator/azimuth', { degrees: clamped });
      } else if (act === 'rotstop') {
        await API.post('/api/devices/rotator/stop', {});
      } else if (act === 'tunmode') {
        await API.post('/api/devices/tuner/mode', { mode: el.dataset.mode });
      } else if (act === 'tunant') {
        await API.post('/api/devices/tuner/antenna', { antenna: Number(el.dataset.ant) });
      }
    } catch (err) { alert(err.message); }
  });

  // Rotator preset dropdown
  document.getElementById('rotPreset').addEventListener('change', async (e) => {
    if (!canControl || !e.target.value) return;
    document.getElementById('azInput').value = e.target.value;
    try { await API.post('/api/devices/rotator/azimuth', { degrees: Number(e.target.value) }); }
    catch (err) { alert(err.message); }
  });

  /* ---------- Rotator jog buttons (click-to-start / click-to-stop) ----------
   * First click starts jogging and sends a heartbeat every 800 ms to keep
   * the server-side 2-second watchdog satisfied. Clicking the active button
   * again, clicking the other direction, or pressing Stop all stop movement.
   * The button turns highlighted (active class) while jogging.
   */
  (function () {
    let _jogTimer = null;
    let _activeDir = null;

    function startJog(dir) {
      if (!canControl) return;
      // Stop any existing jog first
      if (_activeDir) _doStop();
      _activeDir = dir;
      document.getElementById(dir === 'cw' ? 'jogCWBtn' : 'jogCCWBtn').classList.add('active');
      const beat = () => API.post('/api/devices/rotator/jog', { dir }).catch(() => {});
      beat();
      _jogTimer = setInterval(beat, 800);
    }

    function _doStop() {
      clearInterval(_jogTimer);
      _jogTimer = null;
      const prev = _activeDir;
      _activeDir = null;
      if (prev) {
        document.getElementById(prev === 'cw' ? 'jogCWBtn' : 'jogCCWBtn').classList.remove('active');
      }
      API.post('/api/devices/rotator/jog', { dir: 'stop' }).catch(() => {});
    }

    ['jogCCWBtn', 'jogCWBtn'].forEach((id) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      const dir = btn.dataset.jog;
      btn.addEventListener('click', () => {
        if (!canControl) return;
        if (_activeDir === dir) { _doStop(); } else { startJog(dir); }
      });
    });

    // Stop button also kills an active jog
    document.querySelector('[data-act="rotstop"]').addEventListener('click', _doStop, true);
  })();

  /* ---------- Change password modal ---------- */
  const pwModal = document.getElementById('pwModal');
  document.getElementById('pwBtn').onclick = () => pwModal.classList.add('show');
  document.querySelectorAll('[data-close]').forEach((b) => b.onclick = (e) => e.target.closest('.modal-backdrop').classList.remove('show'));
  document.getElementById('pwSave').onclick = async () => {
    const cur = document.getElementById('curPw').value;
    const n1 = document.getElementById('newPw').value;
    const n2 = document.getElementById('newPw2').value;
    const err = document.getElementById('pwErr');
    err.textContent = '';
    if (n1 !== n2) { err.textContent = 'New passwords do not match'; return; }
    try {
      await API.post('/api/auth/change-password', { currentPassword: cur, newPassword: n1 });
      pwModal.classList.remove('show');
      alert('Password updated.');
      document.getElementById('curPw').value = document.getElementById('newPw').value = document.getElementById('newPw2').value = '';
    } catch (e) { err.textContent = e.message; }
  };

  /* ---------- Init ---------- */
  loadActiveTheme();
  loadConfig().then(connectWS);

  // Expose for theme.js / users.js
  window.HAM = { user, canControl };
})();
