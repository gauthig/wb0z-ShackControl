/**
 * routes/users.js - User management. Admin only.
 */
const express = require('express');
const router = express.Router();
const storage = require('../storage');
const auth = require('../auth');

const safe = (u) => ({
  username: u.username,
  displayName: u.displayName || u.username,
  role: u.role,
  disabled: !!u.disabled,
  lastLogin: u.lastLogin || null,
  createdAt: u.createdAt || null
});

// All routes here require admin
router.use(auth.requireAuth, auth.requireRole('admin'));

// GET /api/users
router.get('/', (req, res) => {
  res.json({ users: storage.getUsers().map(safe) });
});

// POST /api/users  { username, password, role, displayName }
router.post('/', (req, res) => {
  const { username, password, role, displayName } = req.body || {};
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'username, password and role are required' });
  }
  if (!auth.ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${auth.ROLES.join(', ')}` });
  }
  if (storage.findUser(username)) {
    return res.status(409).json({ error: 'A user with that username already exists' });
  }
  const newUser = {
    username,
    displayName: displayName || username,
    role,
    passwordHash: auth.hashPassword(password),
    disabled: false,
    createdAt: new Date().toISOString()
  };
  storage.getUsers().push(newUser);
  storage.saveUsers();
  res.status(201).json({ ok: true, user: safe(newUser) });
});

// PUT /api/users/:username  { role, displayName, disabled }
router.put('/:username', (req, res) => {
  const user = storage.findUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { role, displayName, disabled } = req.body || {};
  if (role !== undefined) {
    if (!auth.ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    // Prevent removing the last admin
    if (user.role === 'admin' && role !== 'admin') {
      const admins = storage.getUsers().filter((u) => u.role === 'admin' && !u.disabled);
      if (admins.length <= 1) return res.status(400).json({ error: 'Cannot demote the last admin' });
    }
    user.role = role;
  }
  if (displayName !== undefined) user.displayName = displayName;
  if (disabled !== undefined) {
    if (disabled && user.role === 'admin') {
      const admins = storage.getUsers().filter((u) => u.role === 'admin' && !u.disabled);
      if (admins.length <= 1) return res.status(400).json({ error: 'Cannot disable the last admin' });
    }
    user.disabled = !!disabled;
  }
  storage.saveUsers();
  res.json({ ok: true, user: safe(user) });
});

// POST /api/users/:username/reset-password  { newPassword }
router.post('/:username/reset-password', (req, res) => {
  const user = storage.findUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  user.passwordHash = auth.hashPassword(newPassword);
  user.passwordChangedAt = new Date().toISOString();
  storage.saveUsers();
  res.json({ ok: true, message: 'Password reset' });
});

// DELETE /api/users/:username
router.delete('/:username', (req, res) => {
  const users = storage.getUsers();
  const user = storage.findUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.username.toLowerCase() === req.user.sub.toLowerCase()) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  if (user.role === 'admin') {
    const admins = users.filter((u) => u.role === 'admin' && !u.disabled);
    if (admins.length <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
  }
  storage.setUsers(users.filter((u) => u !== user));
  res.json({ ok: true });
});

module.exports = router;
