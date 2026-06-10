/**
 * routes/auth.js - Login, current-user info, and self password change.
 */
const express = require('express');
const router = express.Router();
const storage = require('../storage');
const auth = require('../auth');

// POST /api/auth/login  { username, password }
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const user = storage.findUser(username);
  if (!user || !auth.verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (user.disabled) {
    return res.status(403).json({ error: 'Account is disabled' });
  }
  user.lastLogin = new Date().toISOString();
  storage.saveUsers();
  const token = auth.issueToken(user);
  res.json({
    token,
    user: { username: user.username, role: user.role, displayName: user.displayName || user.username }
  });
});

// GET /api/auth/me
router.get('/me', auth.requireAuth, (req, res) => {
  const user = storage.findUser(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ username: user.username, role: user.role, displayName: user.displayName || user.username });
});

// POST /api/auth/change-password  { currentPassword, newPassword }
router.post('/change-password', auth.requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const user = storage.findUser(req.user.sub);
  if (!user || !auth.verifyPassword(currentPassword, user.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  user.passwordHash = auth.hashPassword(newPassword);
  user.passwordChangedAt = new Date().toISOString();
  storage.saveUsers();
  res.json({ ok: true, message: 'Password updated successfully' });
});

module.exports = router;
