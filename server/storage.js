/**
 * storage.js - Simple, safe JSON file persistence layer.
 *
 * All application data (users, config, themes) is stored in plain JSON files
 * inside the /config directory. This module loads them on startup, keeps an
 * in-memory copy, and writes atomically on change so a crash mid-write cannot
 * corrupt the file.
 */
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');

const FILES = {
  users: path.join(CONFIG_DIR, 'users.json'),
  config: path.join(CONFIG_DIR, 'config.json'),
  configTemplate: path.join(CONFIG_DIR, 'config.template.json'),
  themes: path.join(CONFIG_DIR, 'themes.json')
};

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[storage] Failed to read ${file}:`, err.message);
    return fallback;
  }
}

/** Atomic write: write to a temp file then rename over the target. */
function writeJSON(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const store = {
  users: null,
  config: null,
  themes: null
};

function init() {
  // Ensure config.json exists; if not, clone it from the template.
  if (!fs.existsSync(FILES.config)) {
    const template = readJSON(FILES.configTemplate, {});
    writeJSON(FILES.config, template);
    console.log('[storage] config.json created from template.');
  }
  store.config = readJSON(FILES.config, {});
  store.themes = readJSON(FILES.themes, { active: 'dark-amber', themes: {} });
  store.users = readJSON(FILES.users, { users: [] });
}

module.exports = {
  init,
  FILES,
  // Users
  getUsers: () => store.users.users,
  findUser: (username) =>
    store.users.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase()),
  saveUsers: () => writeJSON(FILES.users, store.users),
  setUsers: (arr) => { store.users.users = arr; writeJSON(FILES.users, store.users); },
  // Config
  getConfig: () => store.config,
  saveConfig: () => writeJSON(FILES.config, store.config),
  setConfig: (cfg) => { store.config = cfg; writeJSON(FILES.config, store.config); },
  // Themes
  getThemes: () => store.themes,
  saveThemes: () => writeJSON(FILES.themes, store.themes),
  setThemes: (t) => { store.themes = t; writeJSON(FILES.themes, store.themes); }
};
