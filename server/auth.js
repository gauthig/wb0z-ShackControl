/**
 * auth.js - Authentication & role-based authorization.
 *
 * Roles:
 *   - admin     : full control + user management + configuration
 *   - normal    : full device control, can change own password
 *   - viewonly  : read-only, no control actions
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const storage = require('./storage');

const ROLES = ['admin', 'normal', 'viewonly'];

function getSecret() {
  const cfg = storage.getConfig();
  return (cfg.site && cfg.site.jwt_secret) || 'dev-insecure-secret-change-me';
}

function getExpiry() {
  const cfg = storage.getConfig();
  return (cfg.site && cfg.site.jwt_expiry) || '12h';
}

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  try {
    return bcrypt.compareSync(plain, hash);
  } catch {
    return false;
  }
}

function issueToken(user) {
  return jwt.sign(
    { sub: user.username, role: user.role, name: user.displayName || user.username },
    getSecret(),
    { expiresIn: getExpiry() }
  );
}

/** Express middleware: require a valid JWT. Attaches req.user. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, getSecret());
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Express middleware factory: require one of the given roles. */
function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions for this action' });
    }
    next();
  };
}

/** Middleware: block view-only users from control/write actions. */
const requireControl = requireRole('admin', 'normal');

/** Verify a token string (used by the WebSocket handshake). */
function verifyToken(token) {
  try {
    return jwt.verify(token, getSecret());
  } catch {
    return null;
  }
}

module.exports = {
  ROLES,
  hashPassword,
  verifyPassword,
  issueToken,
  requireAuth,
  requireRole,
  requireControl,
  verifyToken
};
