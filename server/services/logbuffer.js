/**
 * logbuffer.js - Intercepts console.log/warn/error into a fixed-size ring buffer
 * so recent server output can be retrieved via the /api/admin/logs endpoint.
 *
 * Call init() once at server startup before any other code logs anything.
 */
const MAX_LINES = 500;

const _lines = [];
const _orig = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

function _push(level, args) {
  const ts = new Date().toISOString();
  const msg = args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  if (_lines.length >= MAX_LINES) _lines.shift();
  _lines.push(`${ts} [${level}] ${msg}`);
}

function init() {
  console.log = (...a) => { _push('INFO', a); _orig.log(...a); };
  console.warn = (...a) => { _push('WARN', a); _orig.warn(...a); };
  console.error = (...a) => { _push('ERROR', a); _orig.error(...a); };
}

/** Return the last n lines (newest last). */
function tail(n = 100) {
  return _lines.slice(-Math.min(n, MAX_LINES));
}

module.exports = { init, tail };
