#!/usr/bin/env node
/**
 * @powforge/captcha-mcp — MCP stdio server entrypoint.
 *
 * This is the npx-installable binary. Implements the Model Context Protocol
 * over stdio using line-delimited JSON-RPC 2.0. No SDK dependency — Node 18+
 * stdlib only.
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
  version: '0.1.0',
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

startStdioLoop();
