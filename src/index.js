/**
 * @powforge/captcha-mcp — MCP server module
 *
 * Wraps the PowForge pow-captcha HTTP service as three MCP tools:
 *   - challenge() → request a fresh PoW challenge
 *   - verify({salt, nonce, signature, id, algo, difficulty}) → verify a solution, return token
 *   - status() → server health + current config
 *
 * Free tier: solve the PoW (SHA-256, ~14 leading zero bits, ~5-10s in browser JS).
 * Paid tier: skip the PoW via L402 Lightning payment (3 sats, RFC 7235 + LN).
 *
 * Tools are exported as plain async functions so they can be tested without
 * spinning up the stdio transport.
 */

'use strict';

const DEFAULT_CAPTCHA_URL = 'http://localhost:3077';

/**
 * Resolve the base URL of the pow-captcha HTTP service. Override via
 * CAPTCHA_URL env var. Defaults to the canonical local-dev port (3077).
 * In production, point this at https://captcha.powforge.dev.
 */
function captchaUrl() {
  const raw = process.env.CAPTCHA_URL || DEFAULT_CAPTCHA_URL;
  return raw.replace(/\/+$/, '');
}

/**
 * Tool: challenge
 *
 * Input shape: {} (no arguments)
 *
 * Output shape:
 *   {
 *     id: string,            // unique challenge id (signed by server)
 *     salt: string,          // hex salt for the PoW
 *     difficulty: number,    // leading zero bits required (e.g. 14)
 *     algo: 'sha256',        // hash algorithm
 *     signature: string,     // server-issued HMAC binding the challenge to the id
 *     instructions: string   // how to solve and return the nonce
 *   }
 *
 * Output shape on error:
 *   { error: string, hint?: string }
 */
async function challenge(_input, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!fetchImpl) {
    return { error: 'fetch_unavailable', hint: 'Node 18+ required, or pass fetchImpl in opts.' };
  }
  try {
    const r = await fetchImpl(`${captchaUrl()}/api/challenge`, { method: 'GET' });
    if (!r.ok) return { error: 'challenge_http_error', status: r.status };
    const ch = await r.json();
    return {
      id: ch.id,
      salt: ch.salt,
      difficulty: ch.difficulty,
      algo: ch.algo || 'sha256',
      signature: ch.signature,
      instructions:
        'Find a nonce string such that ' +
        'SHA-256(salt + nonce) has at least `difficulty` leading zero bits. ' +
        'Then call the verify tool with {salt, nonce, id, signature, algo, difficulty}. ' +
        'Returns a 5-min HMAC token your server can accept as proof-of-human or proof-of-agent. ' +
        'Or skip the PoW by paying the L402 invoice at POST ' + captchaUrl() + '/l402/skip.',
    };
  } catch (e) {
    return { error: 'challenge_request_failed', hint: e.message };
  }
}

/**
 * Tool: verify
 *
 * Input shape:
 *   {
 *     salt: string,
 *     nonce: string,         // string-encoded nonce that solves the PoW
 *     id: string,            // challenge id from the challenge tool
 *     signature: string,     // signature from the challenge tool
 *     algo?: 'sha256',
 *     difficulty?: number    // defaults to challenge difficulty
 *   }
 *
 * Output shape on success:
 *   { valid: true, token: string, method: 'pow' | 'sha256', expires_in_sec: 300 }
 *
 * Output shape on failure:
 *   { valid: false, reason: string }
 */
async function verify(input, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!fetchImpl) {
    return { error: 'fetch_unavailable', hint: 'Node 18+ required, or pass fetchImpl in opts.' };
  }
  if (!input || typeof input !== 'object') return { error: 'input_required' };
  const { salt, nonce, id, signature, algo, difficulty } = input;
  if (!salt || typeof salt !== 'string') return { error: 'salt_required' };
  if (typeof nonce === 'undefined' || nonce === null) return { error: 'nonce_required' };
  if (!id || typeof id !== 'string') return { error: 'id_required' };
  if (!signature || typeof signature !== 'string') return { error: 'signature_required' };

  const body = {
    salt,
    nonce: String(nonce),
    id,
    signature,
    algo: algo || 'sha256',
    difficulty: typeof difficulty === 'number' ? difficulty : undefined,
  };

  try {
    const r = await fetchImpl(`${captchaUrl()}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await r.json();
    if (result.valid) {
      return {
        valid: true,
        token: result.token,
        method: result.method || 'pow',
        expires_in_sec: 300,
        verify_endpoint: `${captchaUrl()}/api/token/verify`,
        hint: 'POST {token} to verify_endpoint to confirm validity from your own backend.',
      };
    }
    return { valid: false, reason: result.reason || 'verification_failed' };
  } catch (e) {
    return { error: 'verify_request_failed', hint: e.message };
  }
}

/**
 * Tool: status
 *
 * Input shape: {} (no arguments)
 *
 * Output shape:
 *   {
 *     ok: true,
 *     captcha_url: string,
 *     stats: { pow_solves: number, ln_skips: number, challenges_issued: number },
 *     l402: { scope: string, price_sats: number, endpoint: string }
 *   }
 *
 * Output shape on failure:
 *   { ok: false, error: string }
 */
async function status(_input, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!fetchImpl) {
    return { ok: false, error: 'fetch_unavailable', hint: 'Node 18+ required, or pass fetchImpl in opts.' };
  }
  const url = captchaUrl();
  try {
    const [statsR, l402R] = await Promise.all([
      fetchImpl(`${url}/api/stats`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetchImpl(`${url}/l402/info`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (!statsR) return { ok: false, error: 'captcha_unreachable', captcha_url: url };

    const ep = (l402R && l402R.endpoints && l402R.endpoints[0]) || null;
    return {
      ok: true,
      captcha_url: url,
      stats: statsR,
      l402: ep
        ? {
            scope: ep.scope,
            price_sats: ep.price_sats,
            endpoint: `${url}${ep.path}`,
            note: 'POST with no auth to receive a 402 + macaroon + bolt11 invoice. Pay, then re-POST with Authorization: L402 <macaroon>:<preimage_hex>.',
          }
        : null,
    };
  } catch (e) {
    return { ok: false, error: 'status_request_failed', hint: e.message, captcha_url: url };
  }
}

/**
 * Tool registry for the MCP server. Each entry is { name, description,
 * inputSchema, handler } so the stdio server can advertise them via
 * tools/list and route tools/call.
 */
const TOOLS = [
  {
    name: 'challenge',
    description:
      'Request a fresh PoW challenge from the PowForge captcha service. Returns {id, salt, difficulty, signature, instructions}. The agent must find a nonce such that SHA-256(salt + nonce) has at least `difficulty` leading zero bits, then call the verify tool. Free tier — no payment required.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: challenge,
  },
  {
    name: 'verify',
    description:
      'Verify a PoW solution. Input: {salt, nonce, id, signature, algo?, difficulty?} from a prior challenge call plus the nonce the agent computed. Returns a 5-minute HMAC-signed token on success, or {valid: false, reason} on failure. Tokens can be re-verified server-side via POST /api/token/verify.',
    inputSchema: {
      type: 'object',
      properties: {
        salt: { type: 'string', description: 'Hex salt from the challenge response' },
        nonce: { type: 'string', description: 'Nonce string the agent computed' },
        id: { type: 'string', description: 'Challenge id from the challenge response' },
        signature: { type: 'string', description: 'HMAC signature from the challenge response' },
        algo: { type: 'string', description: "Hash algorithm. Default: 'sha256'" },
        difficulty: { type: 'number', description: 'Leading zero bits required. Default: matches challenge.' },
      },
      required: ['salt', 'nonce', 'id', 'signature'],
      additionalProperties: false,
    },
    handler: verify,
  },
  {
    name: 'status',
    description:
      'Return PowForge captcha server health, lifetime stats (pow_solves, ln_skips, challenges_issued), and L402 endpoint metadata (scope, price_sats, paid endpoint URL). Use this to discover the Lightning skip price before paying, or as a liveness check.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: status,
  },
];

module.exports = {
  TOOLS,
  challenge,
  verify,
  status,
  captchaUrl,
  DEFAULT_CAPTCHA_URL,
};
