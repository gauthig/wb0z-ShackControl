/**
 * setup.js - One-time bootstrap.
 *
 * Run automatically by index.js on first start (and manually via `npm run setup`).
 * - Ensures config.json exists (cloned from config.template.json).
 * - Ensures users.json exists with the pre-configured admin 'wb0z'.
 * - Generates a random JWT secret if the template placeholder is still present.
 */
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const storage = require('./storage');

const DEFAULT_ADMIN = {
  username: 'wb0z',
  displayName: 'WB0Z',
  role: 'admin',
  password: 'Jasonar-8806'
};

function run() {
  storage.init();

  // 1) Seed users.json if missing or empty
  if (!fs.existsSync(storage.FILES.users) || storage.getUsers().length === 0) {
    const admin = {
      username: DEFAULT_ADMIN.username,
      displayName: DEFAULT_ADMIN.displayName,
      role: DEFAULT_ADMIN.role,
      passwordHash: bcrypt.hashSync(DEFAULT_ADMIN.password, 10),
      disabled: false,
      createdAt: new Date().toISOString()
    };
    storage.setUsers([admin]);
    console.log(`[setup] Created default admin user '${DEFAULT_ADMIN.username}'.`);
  }

  // 2) Generate a real JWT secret if the placeholder is still there
  const cfg = storage.getConfig();
  if (cfg.site && (!cfg.site.jwt_secret || cfg.site.jwt_secret.startsWith('CHANGE_ME'))) {
    cfg.site.jwt_secret = crypto.randomBytes(48).toString('hex');
    storage.setConfig(cfg);
    console.log('[setup] Generated a random JWT secret.');
  }

  console.log('[setup] Setup complete.');
}

// Allow running standalone
if (require.main === module) {
  run();
}

module.exports = { run };
