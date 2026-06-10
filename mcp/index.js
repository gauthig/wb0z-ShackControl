/**
 * mcp/index.js - MCP stdio server for WB0Z ShackControl
 *
 * Runs on the dev machine (this PC). Connects to the ShackControl server
 * running on the remote LAN PC and exposes tools Claude can call during
 * development and testing.
 *
 * Configuration via environment variables (set in .claude/settings.json mcpServers):
 *   SHACK_URL   - e.g. http://192.168.1.100:3000
 *   SHACK_USER  - admin username
 *   SHACK_PASS  - admin password
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');
const http = require('http');
const https = require('https');

const BASE_URL = (process.env.SHACK_URL || 'http://192.168.1.100:3000').replace(/\/$/, '');
const USERNAME = process.env.SHACK_USER || 'admin';
const PASSWORD = process.env.SHACK_PASS || '';

// Cached JWT token
let _token = null;
let _tokenExpiry = 0;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function apiRequest(method, path, body, bearerToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const mod = url.protocol === 'https:' ? https : http;
    const bodyStr = body != null ? JSON.stringify(body) : null;

    const headers = { 'Content-Type': 'application/json' };
    if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const opts = {
      hostname: url.hostname,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 8000
    };

    const req = mod.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: { raw: data } });
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  const res = await apiRequest('POST', '/api/auth/login', { username: USERNAME, password: PASSWORD });
  if (!res.body.token) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  _token = res.body.token;
  _tokenExpiry = Date.now() + 11 * 3600 * 1000; // refresh before 12h expiry
  return _token;
}

async function authedRequest(method, path, body) {
  const token = await getToken();
  return apiRequest(method, path, body, token);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'health_check',
    description:
      'Check if the ShackControl server on the remote PC is running. ' +
      'Returns uptime (seconds), Node version, and PID. No authentication required.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_logs',
    description:
      'Retrieve recent server log lines from the in-memory ring buffer. ' +
      'Use this after deploying a code change or when debugging an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: {
          type: 'number',
          description: 'Number of lines to return (default 100, max 500)'
        }
      }
    }
  },
  {
    name: 'get_status',
    description:
      'Get server uptime, memory usage, and the current live state of all ' +
      'devices (amplifier, rotator, tuner, power switches, FlexRadio).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_devices',
    description:
      'Get the authenticated device state snapshot — same data the dashboard shows. ' +
      'Requires valid credentials.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'restart_server',
    description:
      'Gracefully exit the ShackControl server process so the process manager ' +
      '(Task Scheduler restart-on-failure or NSSM) can restart it. ' +
      'Requires admin credentials. You MUST pass confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: 'Must be true to proceed'
        }
      },
      required: ['confirm']
    }
  }
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------
async function handleTool(name, args) {
  switch (name) {
    case 'health_check': {
      const res = await apiRequest('GET', '/api/admin/health');
      if (res.status !== 200) return `Server returned HTTP ${res.status}: ${JSON.stringify(res.body)}`;
      const { uptime, node, pid, time } = res.body;
      return `Server is UP\nUptime: ${uptime}s  PID: ${pid}  Node: ${node}\nServer time: ${new Date(time).toISOString()}`;
    }

    case 'get_logs': {
      const n = Math.min(500, Math.max(1, Number(args.lines) || 100));
      const res = await apiRequest('GET', `/api/admin/logs?lines=${n}`);
      if (res.status !== 200) return `HTTP ${res.status}: ${JSON.stringify(res.body)}`;
      const lines = res.body.lines || [];
      if (lines.length === 0) return '(log buffer is empty — server may have just started)';
      return lines.join('\n');
    }

    case 'get_status': {
      const res = await apiRequest('GET', '/api/admin/status');
      if (res.status !== 200) return `HTTP ${res.status}: ${JSON.stringify(res.body)}`;
      return JSON.stringify(res.body, null, 2);
    }

    case 'get_devices': {
      const res = await authedRequest('GET', '/api/devices/status');
      if (res.status === 401) return 'Authentication failed — check SHACK_USER and SHACK_PASS';
      if (res.status !== 200) return `HTTP ${res.status}: ${JSON.stringify(res.body)}`;
      return JSON.stringify(res.body, null, 2);
    }

    case 'restart_server': {
      if (!args.confirm) return 'Restart aborted — pass confirm: true to proceed.';
      const res = await authedRequest('POST', '/api/admin/restart', {});
      if (res.status === 401) return 'Authentication failed — check SHACK_USER and SHACK_PASS';
      if (res.status === 403) return 'Forbidden — account does not have admin role';
      return `Restart initiated: ${res.body.message || JSON.stringify(res.body)}`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// MCP server bootstrap
// ---------------------------------------------------------------------------
async function main() {
  const server = new Server(
    { name: 'shackcontrol', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const { name, arguments: args = {} } = req.params;
    try {
      const text = await handleTool(name, args);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(`[shackcontrol-mcp] fatal: ${err.message}\n`);
  process.exit(1);
});
