/**
 * routes/themes.js - Theme/color palette storage & customization.
 *
 * Reading themes: any authenticated user (so the UI can apply the active theme).
 * Creating/updating/deleting themes & setting the active one: admin + normal.
 */
const express = require('express');
const router = express.Router();
const storage = require('../storage');
const auth = require('../auth');

// GET /api/themes
router.get('/', auth.requireAuth, (req, res) => {
  res.json(storage.getThemes());
});

// PUT /api/themes/active  { active }
router.put('/active', auth.requireAuth, auth.requireControl, (req, res) => {
  const t = storage.getThemes();
  const { active } = req.body || {};
  if (!t.themes[active]) return res.status(404).json({ error: 'Theme not found' });
  t.active = active;
  storage.saveThemes();
  res.json({ ok: true, active });
});

// POST /api/themes  { id, name, colors }  (create or update a theme)
router.post('/', auth.requireAuth, auth.requireControl, (req, res) => {
  const { id, name, colors } = req.body || {};
  if (!id || !colors || typeof colors !== 'object') {
    return res.status(400).json({ error: 'id and colors are required' });
  }
  const t = storage.getThemes();
  t.themes[id] = { name: name || id, colors };
  storage.saveThemes();
  res.json({ ok: true, id });
});

// DELETE /api/themes/:id
router.delete('/:id', auth.requireAuth, auth.requireControl, (req, res) => {
  const t = storage.getThemes();
  if (!t.themes[req.params.id]) return res.status(404).json({ error: 'Theme not found' });
  if (Object.keys(t.themes).length <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last theme' });
  }
  delete t.themes[req.params.id];
  if (t.active === req.params.id) t.active = Object.keys(t.themes)[0];
  storage.saveThemes();
  res.json({ ok: true });
});

module.exports = router;
