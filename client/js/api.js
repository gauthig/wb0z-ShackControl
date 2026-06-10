/* api.js - shared helpers: token storage, fetch wrapper, theme application. */
const API = {
  tokenKey: 'hamctl_token',
  userKey: 'hamctl_user',

  getToken() { return localStorage.getItem(this.tokenKey); },
  setToken(t) { localStorage.setItem(this.tokenKey, t); },
  clearToken() { localStorage.removeItem(this.tokenKey); localStorage.removeItem(this.userKey); },

  getUser() { try { return JSON.parse(localStorage.getItem(this.userKey)); } catch { return null; } },
  setUser(u) { localStorage.setItem(this.userKey, JSON.stringify(u)); },

  async req(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) {
      this.clearToken();
      if (!location.pathname.endsWith('index.html') && location.pathname !== '/') {
        location.href = '/';
      }
      throw new Error('Unauthorized');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      let msg = data.error || ('Request failed: ' + res.status);
      if (Array.isArray(data.details) && data.details.length) msg += ' — ' + data.details.join(' ');
      throw new Error(msg);
    }
    return data;
  },
  get(p) { return this.req('GET', p); },
  post(p, b) { return this.req('POST', p, b); },
  put(p, b) { return this.req('PUT', p, b); },
  del(p) { return this.req('DELETE', p); }
};

/* Apply a theme's color object to :root */
function applyThemeColors(colors) {
  const root = document.documentElement;
  Object.entries(colors || {}).forEach(([k, v]) => root.style.setProperty('--' + k, v));
}

/* Load & apply the active theme (no auth required for visuals on login page
   we just fall back to defaults; on dashboard we fetch the saved theme). */
async function loadActiveTheme() {
  try {
    const data = await API.get('/api/themes');
    const t = data.themes[data.active];
    if (t) applyThemeColors(t.colors);
    return data;
  } catch { return null; }
}
