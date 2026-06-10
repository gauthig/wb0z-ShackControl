/* login.js */
(function () {
  // If already logged in, go straight to dashboard.
  if (API.getToken()) { location.href = '/dashboard'; return; }

  const form = document.getElementById('loginForm');
  const errEl = document.getElementById('error');
  const btn = document.getElementById('loginBtn');

  // Fetch site name for the title (public-ish; fails silently)
  fetch('/api/health').catch(() => {});

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const data = await API.post('/api/auth/login', {
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value
      });
      API.setToken(data.token);
      API.setUser(data.user);
      location.href = '/dashboard';
    } catch (err) {
      errEl.textContent = err.message || 'Login failed';
      btn.disabled = false; btn.textContent = 'Sign In';
    }
  });
})();
