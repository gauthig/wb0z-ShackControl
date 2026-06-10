/* users.js - Admin-only user management tab. */
(function () {
  const isAdmin = () => window.HAM && window.HAM.user && window.HAM.user.role === 'admin';
  if (!isAdmin()) return; // tab hidden anyway, but guard the logic

  const modal = document.getElementById('userModal');
  const errEl = document.getElementById('um_err');
  let editingUser = null; // null = create mode

  async function load() {
    const data = await API.get('/api/users');
    const tbody = document.getElementById('userTable');
    tbody.innerHTML = '';
    data.users.forEach((u) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><b>${u.username}</b></td>
        <td>${u.displayName || ''}</td>
        <td><span class="role-badge">${u.role}</span></td>
        <td>${u.disabled ? '<span class="tag off">DISABLED</span>' : '<span class="tag on">ACTIVE</span>'}</td>
        <td class="muted">${u.lastLogin ? new Date(u.lastLogin).toLocaleString() : '—'}</td>
        <td></td>`;
      const actions = tr.lastElementChild;
      actions.appendChild(mkBtn('Edit', '', () => openEdit(u)));
      actions.appendChild(mkBtn('Reset PW', '', () => resetPw(u)));
      actions.appendChild(mkBtn('Delete', 'danger', () => del(u)));
      tbody.appendChild(tr);
    });
  }

  function mkBtn(label, cls, fn) {
    const b = document.createElement('button');
    b.className = 'btn sm ' + cls;
    b.style.marginRight = '4px';
    b.textContent = label;
    b.onclick = fn;
    return b;
  }

  function openCreate() {
    editingUser = null;
    document.getElementById('userModalTitle').textContent = 'Add User';
    document.getElementById('um_username').value = '';
    document.getElementById('um_username').disabled = false;
    document.getElementById('um_display').value = '';
    document.getElementById('um_role').value = 'normal';
    document.getElementById('um_password').value = '';
    document.getElementById('um_pwlabel').style.display = '';
    document.getElementById('um_password').style.display = '';
    errEl.textContent = '';
    modal.classList.add('show');
  }

  function openEdit(u) {
    editingUser = u.username;
    document.getElementById('userModalTitle').textContent = 'Edit ' + u.username;
    document.getElementById('um_username').value = u.username;
    document.getElementById('um_username').disabled = true;
    document.getElementById('um_display').value = u.displayName || '';
    document.getElementById('um_role').value = u.role;
    // Hide password field on edit (use Reset PW instead)
    document.getElementById('um_pwlabel').style.display = 'none';
    document.getElementById('um_password').style.display = 'none';
    errEl.textContent = '';
    modal.classList.add('show');
  }

  document.getElementById('um_save').onclick = async () => {
    errEl.textContent = '';
    const username = document.getElementById('um_username').value.trim();
    const displayName = document.getElementById('um_display').value.trim();
    const role = document.getElementById('um_role').value;
    const password = document.getElementById('um_password').value;
    try {
      if (editingUser) {
        await API.put('/api/users/' + encodeURIComponent(editingUser), { role, displayName });
      } else {
        if (!username || !password) { errEl.textContent = 'Username and password required'; return; }
        await API.post('/api/users', { username, password, role, displayName });
      }
      modal.classList.remove('show');
      load();
    } catch (e) { errEl.textContent = e.message; }
  };

  async function resetPw(u) {
    const np = prompt('New password for ' + u.username + ' (min 6 chars):');
    if (!np) return;
    try { await API.post('/api/users/' + encodeURIComponent(u.username) + '/reset-password', { newPassword: np }); alert('Password reset.'); }
    catch (e) { alert(e.message); }
  }

  async function del(u) {
    if (!confirm('Delete user "' + u.username + '"?')) return;
    try { await API.del('/api/users/' + encodeURIComponent(u.username)); load(); }
    catch (e) { alert(e.message); }
  }

  document.getElementById('addUserBtn').onclick = openCreate;

  // Load when the Users tab is first shown
  document.querySelector('[data-tab="users"]').addEventListener('click', load, { once: false });
  load();
})();
