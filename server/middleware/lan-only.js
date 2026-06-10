/**
 * lan-only.js - Middleware that restricts access to 192.168.1.x and localhost.
 * Applied to all /api/admin/* routes so the admin surface is never reachable
 * from outside the local LAN.
 */
function lanOnly(req, res, next) {
  const raw = req.ip || (req.socket && req.socket.remoteAddress) || '';
  // Express may prefix IPv4 addresses with ::ffff: when running in dual-stack mode
  const ip = raw.replace(/^::ffff:/, '');
  const allowed =
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('192.168.1.');
  if (!allowed) {
    return res.status(403).json({ error: 'Forbidden: LAN access only', ip });
  }
  next();
}

module.exports = lanOnly;
