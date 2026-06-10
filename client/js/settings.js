/* settings.js - Admin-only settings screen: load, validate, save, feedback. */
(function () {
  if (!API.getToken()) { location.href = '/'; return; }
  const user = API.getUser() || {};
  if (user.role !== 'admin') { alert('Settings are admin-only.'); location.href = '/dashboard'; return; }

  // Header
  document.getElementById('userName').textContent = user.displayName || user.username;
  document.getElementById('roleBadge').textContent = user.role || '';
  document.getElementById('backBtn').onclick = () => location.href = '/dashboard';
  document.getElementById('logoutBtn').onclick = () => { API.clearToken(); location.href = '/'; };

  const okMsg = document.getElementById('okMsg');
  const errMsg = document.getElementById('errMsg');

  // Schema: section -> { key: type }. Types: 'text' | 'num' | 'bool'
  const SCHEMA = {
    general: { site_name: 'text', station_callsign: 'text', http_port: 'num', bind_address: 'text', jwt_expiry: 'text' },
    mqtt: { enabled: 'bool', broker: 'text', port: 'num', username: 'text', password: 'text', client_id: 'text', topic_prefix: 'text', publish_interval_sec: 'num' },
    serial: { enabled: 'bool', serial_port: 'text', baud_rate: 'num' },
    flexradio: { enabled: 'bool', host_mode: 'text', host: 'text', discovery_port: 'num', tcp_port: 'num' },
    rotator: { enabled: 'bool', serial_port: 'text', baud_rate: 'num' },
    tuner: { enabled: 'bool', send_address: 'text', send_port: 'num', listen_port: 'num' },
    home_assistant: { enabled: 'bool', base_url: 'text', token: 'text', topic_prefix: 'text', power_supply_id: 'text', amplifier_id: 'text', radio_relay_id: 'text', desk_light_1_id: 'text', desk_light_2_id: 'text' }
  };

  const el = (section, key) => document.getElementById(`${section}_${key}`);

  function populate(settings) {
    Object.entries(SCHEMA).forEach(([section, keys]) => {
      const data = settings[section] || {};
      Object.entries(keys).forEach(([key, type]) => {
        const node = el(section, key);
        if (!node) return;
        const val = data[key];
        if (type === 'bool') node.checked = !!val;
        else node.value = (val === undefined || val === null) ? '' : val;
      });
    });
  }

  function gather() {
    const out = {};
    Object.entries(SCHEMA).forEach(([section, keys]) => {
      out[section] = {};
      Object.entries(keys).forEach(([key, type]) => {
        const node = el(section, key);
        if (!node) return;
        if (type === 'bool') out[section][key] = node.checked;
        else if (type === 'num') out[section][key] = node.value === '' ? '' : Number(node.value);
        else out[section][key] = node.value.trim();
      });
    });
    return out;
  }

  // Client-side validation mirrors the server checks for instant feedback.
  function clientValidate(s) {
    const errs = [];
    const isPort = (v) => v === '' || (Number.isInteger(v) && v >= 1 && v <= 65535);
    const ip = /^(\d{1,3})(\.\d{1,3}){3}$/;
    const portFields = [
      ['Server port', s.general.http_port], ['MQTT port', s.mqtt.port],
      ['Tuner command port', s.tuner.send_port], ['Tuner status port', s.tuner.listen_port],
      ['FlexRadio discovery port', s.flexradio.discovery_port], ['FlexRadio TCP port', s.flexradio.tcp_port]
    ];
    portFields.forEach(([label, v]) => { if (!isPort(v)) errs.push(`${label} must be 1–65535.`); });
    if (s.tuner.send_address && !ip.test(s.tuner.send_address)) errs.push('Tuner IP address is invalid.');
    if (s.mqtt.enabled && !s.mqtt.broker) errs.push('MQTT broker is required when MQTT is enabled.');
    if (s.serial.baud_rate !== '' && (!Number.isInteger(s.serial.baud_rate) || s.serial.baud_rate <= 0)) errs.push('Baud rate must be positive.');
    return errs;
  }

  function showOk(msg) { okMsg.textContent = msg; errMsg.textContent = ''; setTimeout(() => { okMsg.textContent = ''; }, 5000); }
  function showErr(msg) { errMsg.textContent = msg; okMsg.textContent = ''; }

  async function load() {
    try {
      const settings = await API.get('/api/settings');
      populate(settings);
      // Reflect whether an HA token is already saved (it is never sent back to us).
      const tokenInput = el('home_assistant', 'token');
      if (tokenInput) {
        tokenInput.placeholder = (settings.home_assistant && settings.home_assistant.token_set)
          ? 'token saved — leave blank to keep it'
          : 'paste Home Assistant long-lived token';
      }
      document.getElementById('siteName').textContent = (settings.general && settings.general.site_name) || 'Shack Control';
      if (settings.general && settings.general.station_callsign) document.getElementById('callsign').textContent = settings.general.station_callsign;
    } catch (e) { showErr('Failed to load settings: ' + e.message); }
  }

  document.getElementById('reloadBtn').onclick = () => { load(); showOk('Reloaded from server.'); };

  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = gather();
    const errs = clientValidate(data);
    if (errs.length) { showErr(errs.join(' ')); return; }
    const btn = document.getElementById('saveBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await API.put('/api/settings', data);
      populate(res.settings);
      showOk(res.message || 'Settings saved.');
    } catch (e) {
      // Server returns {error, details:[]} on validation failure
      showErr(e.message || 'Save failed.');
    } finally {
      btn.disabled = false; btn.textContent = 'Save Settings';
    }
  });

  loadActiveTheme();
  load();
})();
