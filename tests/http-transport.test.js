/**
 * @powforge/captcha-mcp — HTTP Streamable transport tests.
 *
 * Exercises the HTTP shim added in v0.2.0. Spawns the server as a child process
 * with HTTP_MODE=1 on an ephemeral port, then drives the protocol surface
 * Smithery uses to scan a server: POST /mcp with initialize, tools/list, and
 * a few negative cases (malformed JSON, batch requests, GET SSE).
 *
 * Tool execution is NOT exercised here — that requires the upstream captcha
 * service. Module-level tool tests (server.test.js) cover that surface with
 * a fake fetchImpl. This file only proves the transport routes correctly.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const net = require('node:net');

const SERVER_PATH = path.join(__dirname, '..', 'src', 'server.js');

// Pick an ephemeral free port — node binds 0, asks the OS, then closes so the
// child can re-bind. There is a microscopic race (the OS could hand the port
// to another process) but for a test runner on a quiet box it is reliable.
function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForReady(stderr) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('HTTP transport listening')) {
        stderr.off('data', onData);
        resolve();
      }
    };
    stderr.on('data', onData);
    setTimeout(() => {
      stderr.off('data', onData);
      reject(new Error(`server did not become ready in 5s. stderr so far: ${buf}`));
    }, 5000).unref();
  });
}

let proc;
let port;
let baseUrl;

before(async () => {
  port = await pickPort();
  proc = spawn(process.execPath, [SERVER_PATH, '--http'], {
    env: { ...process.env, PORT: String(port), CAPTCHA_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForReady(proc.stderr);
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (proc && !proc.killed) {
    proc.kill('SIGTERM');
    // Give graceful shutdown a beat, then SIGKILL if still alive.
    await Promise.race([once(proc, 'exit'), new Promise((r) => setTimeout(r, 2000))]);
    if (!proc.killed) proc.kill('SIGKILL');
  }
});

test('GET /health returns ok and server info', async () => {
  const r = await fetch(`${baseUrl}/health`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.transport, 'http');
  assert.equal(body.server.name, '@powforge/captcha-mcp');
});

test('POST /mcp initialize returns protocol version and server info', async () => {
  const r = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/json');
  const body = await r.json();
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, 1);
  assert.equal(body.result.protocolVersion, '2024-11-05');
  assert.equal(body.result.serverInfo.name, '@powforge/captcha-mcp');
  assert.ok(body.result.capabilities.tools, 'tools capability advertised');
});

test('POST /mcp tools/list returns the three captcha tools', async () => {
  const r = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.id, 2);
  const names = body.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['challenge', 'status', 'verify']);
  for (const t of body.result.tools) {
    assert.ok(t.description && t.description.length > 0);
    assert.ok(t.inputSchema && t.inputSchema.type === 'object');
  }
});

test('POST /mcp ping returns empty result', async () => {
  const r = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.result, {});
});

test('POST /mcp notifications/initialized returns 202 with no body', async () => {
  const r = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(r.status, 202);
  const text = await r.text();
  assert.equal(text, '');
});

test('POST /mcp with malformed JSON returns 400 + parse error', async () => {
  const r = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error.code, -32700);
  assert.match(body.error.message, /Parse error/);
});

test('POST /mcp with non-JSON-RPC payload returns 400 + invalid request', async () => {
  const r = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error.code, -32600);
});

test('POST /mcp with batch returns 400 (batch not supported)', async () => {
  const r = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ]),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error.code, -32600);
  assert.match(body.error.message, /Batch/);
});

test('POST /mcp unknown method returns -32601 inside 200', async () => {
  const r = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'no/such/method' }),
  });
  // Per JSON-RPC, method-not-found is a protocol-level error returned in the
  // response envelope with HTTP 200, not an HTTP 404.
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.id, 99);
  assert.equal(body.error.code, -32601);
});

test('GET /mcp opens an SSE stream with a heartbeat preamble', async () => {
  // We can't easily wait 25s for a heartbeat in CI, so we just verify the
  // response headers + initial preamble byte arrives.
  const ac = new AbortController();
  const r = await fetch(`${baseUrl}/mcp`, {
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
    signal: ac.signal,
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  assert.equal(r.headers.get('cache-control'), 'no-cache, no-transform');

  const reader = r.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /captcha-mcp sse open/);
  ac.abort();
  // Drain any pending bytes so the test runner can exit.
  try { await reader.cancel(); } catch (_) { /* already aborted */ }
});

test('OPTIONS /mcp returns 204 with CORS headers', async () => {
  const r = await fetch(`${baseUrl}/mcp`, { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-allow-methods'), /POST/);
});

test('GET /unknown returns 404 JSON', async () => {
  const r = await fetch(`${baseUrl}/nope`);
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.equal(body.error, 'not_found');
});

test('POST /mcp without Content-Type still parses (Smithery sends bare body)', async () => {
  // Some hosted clients omit Content-Type. We don't strictly require it —
  // we only parse the body. Verify that path works.
  const r = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping' }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.id, 11);
});
