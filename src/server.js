#!/usr/bin/env node
/**
 * @powforge/captcha-mcp — MCP server entrypoint.
 *
 * This is the npx-installable binary. Implements the Model Context Protocol
 * over two transports — stdio (default, line-delimited JSON-RPC 2.0) and
 * HTTP Streamable (opt-in via --http or HTTP_MODE=1, used by Smithery and
 * other hosted MCP clients). No SDK dependency — Node 18+ stdlib only.
 *
 * Designed to be referenced from a Claude Code / Cursor / Continue MCP config:
 *
 *     {
 *       "mcpServers": {
 *         "powforge-captcha": {
 *           "command": "npx",
 *           "args": ["-y", "@powforge/captcha-mcp"]
 *         }
 *       }
 *     }
 *
 * Optional environment variables:
 *   CAPTCHA_URL   override the captcha base URL (default: http://localhost:3077)
 *
 * Why stdlib only:
 *   - Smaller install footprint (`npx -y` is faster).
 *   - No transitive deps to audit.
 *   - The MCP protocol is simple line-delimited JSON-RPC 2.0; the SDK is
 *     ~200 lines of glue we can replicate in <100 lines here.
 */

'use strict';

const { TOOLS } = require('./index.js');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = {
  name: '@powforge/captcha-mcp',
  version: '0.2.0',
};

// --install: print a ready-to-paste MCP config block. We don't write to the
// user's config — config paths vary across editors and that's their decision.
if (process.argv.includes('--install') || process.argv.includes('-i')) {
  const block = {
    mcpServers: {
      'powforge-captcha': {
        command: 'npx',
        args: ['-y', '@powforge/captcha-mcp'],
      },
    },
  };
  // eslint-disable-next-line no-console
  console.log('Add this block to your MCP config (e.g. ~/.config/Claude/claude_desktop_config.json):\n');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(block, null, 2));
  // eslint-disable-next-line no-console
  console.log('\nThen restart your MCP client. The three tools (challenge, verify, status) will appear automatically.');
  process.exit(0);
}

// --version: print version and exit. Useful for CI smoke tests.
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  // eslint-disable-next-line no-console
  console.log(SERVER_INFO.version);
  process.exit(0);
}

/**
 * Send a JSON-RPC response on stdout. Stdout MUST stay strictly JSON-RPC —
 * any stray writes to stdout will corrupt the framing. Diagnostics go to
 * stderr.
 */
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function makeError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

function makeResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Handle one incoming JSON-RPC request and return a response (or null for
 * notifications). Methods implemented:
 *   - initialize
 *   - notifications/initialized  (notification, no response)
 *   - tools/list
 *   - tools/call
 *   - ping
 */
async function handle(req) {
  const id = req.id;
  const method = req.method;
  const params = req.params || {};

  if (method === 'initialize') {
    return makeResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === 'notifications/initialized' || method === 'initialized') {
    // Notifications have no id and expect no response.
    return null;
  }

  if (method === 'ping') {
    return makeResult(id, {});
  }

  if (method === 'tools/list') {
    return makeResult(id, {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return makeResult(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool', tool: name }) }],
        isError: true,
      });
    }
    try {
      const result = await tool.handler(args);
      return makeResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      return makeResult(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: 'tool_threw', message: e.message }) }],
        isError: true,
      });
    }
  }

  // Unknown method.
  return makeError(id, -32601, `Method not found: ${method}`);
}

/**
 * HTTP Streamable transport — required by Smithery and other hosted MCP clients.
 *
 * Per the MCP spec (Streamable HTTP, 2024-11-05+):
 *   - POST /mcp  with Content-Type: application/json — body is one JSON-RPC
 *     request, response is one JSON-RPC response (single-response mode).
 *     Notifications return 202 Accepted with empty body.
 *   - GET /mcp   opens an SSE stream for server-initiated messages. We hold
 *     it open with a comment heartbeat — captcha-mcp never pushes events
 *     unsolicited, but Smithery's tool-scan probes this endpoint.
 *
 * Stateless. No session ids. All three captcha tools are pure HTTP wrappers
 * around the upstream pow-captcha service, so concurrency is trivially safe.
 */
function startHttpServer() {
  const http = require('http');
  const port = parseInt(process.env.PORT, 10) || 3200;

  const server = http.createServer(async (req, res) => {
    // CORS for hosted MCP clients (Smithery, browser-based hosts).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept, Mcp-Session-Id, Authorization'
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url || '/';
    // Accept both /mcp (canonical) and / (some hosts probe root). Same handler.
    const isMcpPath = url === '/mcp' || url === '/' || url.startsWith('/mcp?');

    // Health probe — uptime check for deployers, not part of MCP.
    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: SERVER_INFO, transport: 'http' }));
      return;
    }

    if (!isMcpPath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', hint: 'POST /mcp for JSON-RPC' }));
      return;
    }

    // GET /mcp → SSE stream. Smithery's scanner opens this; some clients
    // also keep it open for server-pushed notifications. We never push
    // unsolicited events, but the stream must stay readable.
    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      // Initial comment so the stream is non-empty (some proxies wait for first byte).
      res.write(': captcha-mcp sse open\n\n');
      // Heartbeat every 25s. Caddy / load balancers often idle-close at 30s.
      const beat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch (_) { /* socket closed */ }
      }, 25000);
      req.on('close', () => clearInterval(beat));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, POST, OPTIONS' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    // POST /mcp → single JSON-RPC request, single JSON-RPC response.
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      // 1 MB cap — captcha tools have tiny payloads, anything bigger is abuse.
      if (body.length > 1_000_000) {
        req.destroy();
      }
    });
    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(makeError(null, -32700, `Parse error: ${e.message}`)));
        return;
      }

      // Reject batches — single-response transport only. The MCP spec allows
      // batches but Smithery and most hosted clients use single requests.
      if (Array.isArray(parsed)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(makeError(null, -32600, 'Batch requests not supported')));
        return;
      }

      if (!parsed || typeof parsed !== 'object' || parsed.jsonrpc !== '2.0' || !parsed.method) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            makeError(parsed && parsed.id !== undefined ? parsed.id : null, -32600, 'Invalid Request')
          )
        );
        return;
      }

      try {
        const resp = await handle(parsed);
        if (resp === null) {
          // Notification — no response body expected.
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resp));
      } catch (e) {
        process.stderr.write(`@powforge/captcha-mcp: http handler error: ${e.message}\n`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            makeError(parsed.id !== undefined ? parsed.id : null, -32603, `Internal error: ${e.message}`)
          )
        );
      }
    });
    req.on('error', (e) => {
      process.stderr.write(`@powforge/captcha-mcp: http request error: ${e.message}\n`);
    });
  });

  server.listen(port, () => {
    process.stderr.write(
      `@powforge/captcha-mcp ${SERVER_INFO.version} HTTP transport listening on :${port} ` +
        `(POST /mcp, GET /mcp, GET /health). CAPTCHA_URL=${process.env.CAPTCHA_URL || 'http://localhost:3077'}\n`
    );
  });

  // Graceful shutdown so deploy restarts don't drop in-flight requests.
  function shutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Read stdin line-by-line. Each line is a complete JSON-RPC message. Per the
 * MCP stdio spec, embedded newlines are not allowed inside a message.
 */
function startStdioLoop() {
  let buf = '';
  let inFlight = 0;
  let stdinEnded = false;

  process.stdin.setEncoding('utf8');

  async function processRequest(req) {
    inFlight++;
    try {
      const resp = await handle(req);
      if (resp !== null) send(resp);
    } catch (e) {
      // eslint-disable-next-line no-console
      process.stderr.write(`@powforge/captcha-mcp: handler error: ${e.message}\n`);
      if (req && typeof req.id !== 'undefined') {
        send(makeError(req.id, -32603, `Internal error: ${e.message}`));
      }
    } finally {
      inFlight--;
      if (stdinEnded && inFlight === 0) process.exit(0);
    }
  }

  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;

      let req;
      try {
        req = JSON.parse(line);
      } catch (e) {
        // eslint-disable-next-line no-console
        process.stderr.write(`@powforge/captcha-mcp: malformed JSON-RPC line: ${e.message}\n`);
        continue;
      }

      // Fire-and-track. processRequest decrements inFlight when done.
      processRequest(req);
    }
  });

  process.stdin.on('end', () => {
    // Client closed the pipe. Wait for in-flight handlers to finish before
    // exiting so async tool calls (HTTP fetches) can return their responses.
    stdinEnded = true;
    if (inFlight === 0) process.exit(0);
  });

  // Diagnostic banner on stderr only. Stdout is reserved for JSON-RPC.
  process.stderr.write(
    `@powforge/captcha-mcp ${SERVER_INFO.version} ready. ` +
      `CAPTCHA_URL=${process.env.CAPTCHA_URL || 'http://localhost:3077'}\n`
  );
}

// Transport selection. Default is stdio so existing `npx @powforge/captcha-mcp`
// invocations keep working unchanged. HTTP mode is opt-in for hosted MCP
// clients (Smithery) and `node src/server.js --http` local testing.
const wantsHttp =
  process.argv.includes('--http') ||
  process.env.HTTP_MODE === '1' ||
  process.env.MCP_TRANSPORT === 'http';

if (wantsHttp) {
  startHttpServer();
} else {
  startStdioLoop();
}
