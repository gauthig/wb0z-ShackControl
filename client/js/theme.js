/* theme.js - Appearance tab: list themes, live-edit palette, save & apply. */
(function () {
  const COLOR_KEYS = [
    ['bg', 'Background'], ['surface', 'Surface'], ['surface2', 'Surface 2'],
    ['border', 'Border'], ['text', 'Text'], ['text-muted', 'Muted Text'],
    ['primary', 'Primary'], ['primary-text', 'Primary Text'], ['accent', 'Accent'],
    ['success', 'Success'], ['warning', 'Warning'], ['danger', 'Danger'],
    ['gauge-track', 'Gauge Track']
  ];

  let themesData = { active: '', themes: {} };
  const msg = document.getElementById('themeMsg');
  const canControl = () => window.HAM && window.HAM.canControl;

  async function load() {
    themesData = await API.get('/api/themes');
    renderList();
    loadIntoEditor(themesData.themes[themesData.active], themesData.active);
  }

  function renderList() {
    const wrap = document.getElementById('themeList');
    wrap.innerHTML = '';
    Object.entries(themesData.themes).forEach(([id, t]) => {
      const card = document.createElement('div');
      card.className = 'theme-card' + (id === themesData.active ? ' active' : '');
      const swatches = ['primary', 'accent', 'success', 'warning', 'danger', 'surface']
        .map((k) => `<span style="background:${t.colors[k] || '#000'}"></span>`).join('');
      card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
          <b>${t.name || id}</b>
          ${id === themesData.active ? '<span class="tag on">ACTIVE</span>' : ''}
        </div>
        <div class="theme-preview">${swatches}</div>
        <div class="controls" style="margin-top:10px">
          <button class="btn sm" data-apply="${id}" ${canControl() ? '' : 'disabled'}>Apply</button>
          <button class="btn sm" data-edit="${id}">Edit</button>
          <button class="btn sm danger" data-del="${id}" ${canControl() ? '' : 'disabled'}>Delete</button>
        </div>`;
      wrap.appendChild(card);
    });

    wrap.querySelectorAll('[data-apply]').forEach((b) => b.onclick = () => applyTheme(b.dataset.apply));
    wrap.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () =>
      loadIntoEditor(themesData.themes[b.dataset.edit], b.dataset.edit));
    wrap.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => delTheme(b.dataset.del));
  }

  function loadIntoEditor(theme, id) {
    if (!theme) return;
    document.getElementById('themeName').value = theme.name || id;
    document.getElementById('themeId').value = id;
    const ed = document.getElementById('colorEditor');
    ed.innerHTML = '';
    COLOR_KEYS.forEach(([key, label]) => {
      const row = document.createElement('div');
      row.className = 'swatch-row';
      const val = theme.colors[key] || '#000000';
      row.innerHTML = `<label>${label}</label>
        <input type="color" value="${toHex(val)}" data-ck="${key}" style="width:48px" />`;
      ed.appendChild(row);
    });
    // Live preview on change
    ed.querySelectorAll('input[type=color]').forEach((inp) => {
      inp.oninput = () => document.documentElement.style.setProperty('--' + inp.dataset.ck, inp.value);
    });
  }

  function toHex(c) {
    if (/^#([0-9a-f]{6})$/i.test(c)) return c;
    if (/^#([0-9a-f]{3})$/i.test(c)) return '#' + c.slice(1).split('').map((x) => x + x).join('');
    return '#000000';
  }

  function gatherColors() {
    const colors = {};
    document.querySelectorAll('#colorEditor input[type=color]').forEach((inp) => {
      colors[inp.dataset.ck] = inp.value;
    });
    return colors;
  }

  async function applyTheme(id) {
    if (!canControl()) return;
    try {
      await API.put('/api/themes/active', { active: id });
      const t = themesData.themes[id];
      if (t) applyThemeColors(t.colors);
      themesData.active = id;
      renderList();
    } catch (e) { alert(e.message); }
  }

  async function delTheme(id) {
    if (!canControl()) return;
    if (!confirm('Delete theme "' + id + '"?')) return;
    try { await API.del('/api/themes/' + id); await load(); }
    catch (e) { alert(e.message); }
  }

  document.getElementById('saveThemeBtn').onclick = async () => {
    if (!canControl()) { msg.textContent = ''; alert('View-only users cannot save themes.'); return; }
    const id = document.getElementById('themeId').value.trim().replace(/\s+/g, '-').toLowerCase();
    const name = document.getElementById('themeName').value.trim() || id;
    if (!id) { alert('Theme id required'); return; }
    try {
      await API.post('/api/themes', { id, name, colors: gatherColors() });
      await applyTheme(id);
      await load();
      msg.textContent = 'Saved & applied "' + name + '".';
      setTimeout(() => msg.textContent = '', 3000);
    } catch (e) { alert(e.message); }
  };

  document.getElementById('resetEditorBtn').onclick = () =>
    loadIntoEditor(themesData.themes[themesData.active], themesData.active);

  load();
})();
