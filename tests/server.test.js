/**
 * @powforge/captcha-mcp — module tests.
 *
 * Tests the tool implementations in isolation by passing a fake fetchImpl.
 * The stdio transport itself is not tested here (covered by manual smoke
 * tests in CI; see README "Smoke-test the protocol manually").
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TOOLS, challenge, verify, status, captchaUrl, DEFAULT_CAPTCHA_URL } = require('../src/index.js');

test('TOOLS exports three tools with required fields', () => {
  assert.equal(TOOLS.length, 3);
  for (const t of TOOLS) {
    assert.ok(typeof t.name === 'string' && t.name.length > 0);
    assert.ok(typeof t.description === 'string' && t.description.length > 0);
    assert.ok(t.inputSchema && typeof t.inputSchema === 'object');
    assert.ok(typeof t.handler === 'function');
  }
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, ['challenge', 'status', 'verify']);
});

test('captchaUrl defaults to local pow-captcha port', () => {
  delete process.env.CAPTCHA_URL;
  assert.equal(captchaUrl(), DEFAULT_CAPTCHA_URL);
});

test('captchaUrl honors CAPTCHA_URL env var and trims trailing slash', () => {
  process.env.CAPTCHA_URL = 'https://captcha.powforge.dev/';
  assert.equal(captchaUrl(), 'https://captcha.powforge.dev');
  delete process.env.CAPTCHA_URL;
});

test('challenge returns parsed challenge with instructions', async () => {
  const fakeFetch = async (url) => {
    assert.match(url, /\/api\/challenge$/);
    return {
      ok: true,
      json: async () => ({
        id: 'abc.123',
        salt: 'aabbcc',
        difficulty: 14,
        algo: 'sha256',
        signature: 'deadbeef',
      }),
    };
  };
  const r = await challenge({}, { fetchImpl: fakeFetch });
  assert.equal(r.id, 'abc.123');
  assert.equal(r.salt, 'aabbcc');
  assert.equal(r.difficulty, 14);
  assert.equal(r.algo, 'sha256');
  assert.match(r.instructions, /SHA-256/);
});

test('challenge surfaces HTTP error', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const r = await challenge({}, { fetchImpl: fakeFetch });
  assert.equal(r.error, 'challenge_http_error');
  assert.equal(r.status, 503);
});

test('verify rejects missing input fields', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ valid: true, token: 'x' }) });
  assert.equal((await verify(null, { fetchImpl: fakeFetch })).error, 'input_required');
  assert.equal((await verify({}, { fetchImpl: fakeFetch })).error, 'salt_required');
  assert.equal((await verify({ salt: 'a' }, { fetchImpl: fakeFetch })).error, 'nonce_required');
  assert.equal((await verify({ salt: 'a', nonce: '1' }, { fetchImpl: fakeFetch })).error, 'id_required');
  assert.equal((await verify({ salt: 'a', nonce: '1', id: 'x' }, { fetchImpl: fakeFetch })).error, 'signature_required');
});

test('verify returns success token on valid PoW', async () => {
  const fakeFetch = async (url, opts) => {
    assert.match(url, /\/api\/verify$/);
    const body = JSON.parse(opts.body);
    assert.equal(body.salt, 'aabbcc');
    assert.equal(body.nonce, '42');
    return {
      ok: true,
      json: async () => ({ valid: true, token: 'tok.sig', method: 'sha256' }),
    };
  };
  const r = await verify(
    { salt: 'aabbcc', nonce: '42', id: 'abc.123', signature: 'deadbeef' },
    { fetchImpl: fakeFetch }
  );
  assert.equal(r.valid, true);
  assert.equal(r.token, 'tok.sig');
  assert.equal(r.method, 'sha256');
  assert.equal(r.expires_in_sec, 300);
});

test('verify surfaces server reason on failure', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ valid: false, reason: 'insufficient work' }),
  });
  const r = await verify(
    { salt: 'a', nonce: '1', id: 'b', signature: 'c' },
    { fetchImpl: fakeFetch }
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'insufficient work');
});

test('status returns ok with stats and l402 metadata', async () => {
  const fakeFetch = async (url) => {
    if (url.endsWith('/api/stats')) {
      return { ok: true, json: async () => ({ pow_solves: 57, ln_skips: 0, challenges_issued: 800 }) };
    }
    if (url.endsWith('/l402/info')) {
      return {
        ok: true,
        json: async () => ({
          service: 'pow-captcha',
          endpoints: [{ path: '/l402/skip', scope: 'pow-captcha:skip', price_sats: 3 }],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const r = await status({}, { fetchImpl: fakeFetch });
  assert.equal(r.ok, true);
  assert.equal(r.stats.pow_solves, 57);
  assert.equal(r.l402.scope, 'pow-captcha:skip');
  assert.equal(r.l402.price_sats, 3);
  assert.match(r.l402.endpoint, /\/l402\/skip$/);
});

test('status returns unreachable when stats fetch fails', async () => {
  const fakeFetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const r = await status({}, { fetchImpl: fakeFetch });
  assert.equal(r.ok, false);
  // Either captcha_unreachable (when stats returned null) or status_request_failed.
  assert.ok(['captcha_unreachable', 'status_request_failed'].includes(r.error));
});
