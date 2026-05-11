/**
 * @powforge/captcha-mcp — Rune PoW Fair-Launch Scaffold
 *
 * Tick 544, build/141 (research/rune-pow-fairlaunch-design.md).
 *
 * Off-chain enforcement model: PowForge etches a Rune with premine = total
 * supply, then gates transfers behind the existing pow-captcha PoW challenge.
 * Solve the PoW, supply a Bitcoin recipient address, get back a signed Rune
 * transfer transaction (or a PSBT to sign yourself).
 *
 * This file is the **scaffold** — it does NOT yet construct real Bitcoin
 * transactions. It validates the input contract, gates on PoW verification
 * via the existing captcha-mcp verify() handler, enforces the per-address
 * 24h rate limit, and returns a structured "coming-soon" stub that documents
 * the missing pieces (runestone-lib install + relay key + ord indexer).
 *
 * The route shape, return contract, error codes, and rate-limit semantics are
 * STABLE. The next tick swaps the stub body for real tx construction without
 * changing the API surface. Phase 1 = local-regtest validation. Phase 2 = signet.
 * Phase 3 = mainnet (Fubz-gated).
 */

'use strict';

const crypto = require('crypto');
const { verify: captchaVerify } = require('./index.js');

// =============================================================================
// CONSTANTS — match design doc §"Rune configuration"
// =============================================================================

const RUNE_NAME = 'POWFORGE•PROOF';
const RUNE_SYMBOL = '⚒';
const RUNE_DIVISIBILITY = 0;
const RUNE_TOTAL_SUPPLY = 21_000_000;
const RUNE_PARCEL_SIZE = 1_000;
const RUNE_PARCEL_COUNT = RUNE_TOTAL_SUPPLY / RUNE_PARCEL_SIZE; // 21,000

// Per-recipient rate limit: 1 claim per address per 24h
const CLAIM_RATE_LIMIT_MS = 24 * 60 * 60 * 1000;

// In-memory claim ledger (PRODUCTION: persist to data/rune-claims.jsonl).
// Maps recipient_address -> { claimed_at_ms, parcel_id, txid|null }
const claimsByAddress = new Map();

// Sequential parcel counter — wraps a real on-chain UTXO cursor in production
let parcelsClaimed = 0;

// =============================================================================
// ADDRESS VALIDATION — Bitcoin mainnet only for phase 1.
// Accepts: P2WPKH (bc1q...), P2TR (bc1p...), legacy P2PKH (1...), P2SH (3...).
// Rejects: testnet, signet, regtest prefixes (handled separately when those
// networks are wired in).
// =============================================================================

function looksLikeBitcoinMainnetAddress(addr) {
  if (typeof addr !== 'string') return false;
  if (addr.length < 26 || addr.length > 90) return false;
  // P2WPKH or P2TR (bech32 / bech32m): bc1q (P2WPKH, 42 chars) or bc1p (P2TR, 62 chars)
  if (/^bc1[qp][a-z0-9]{38,90}$/.test(addr)) return true;
  // P2PKH legacy: starts with 1, base58, ~26-35 chars
  if (/^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(addr)) return true;
  // P2SH: starts with 3
  if (/^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(addr)) return true;
  return false;
}

// =============================================================================
// SCAFFOLD HANDLERS
// =============================================================================

/**
 * Return the public claim metadata: rune config, current state, PoW
 * requirements, how to claim. Idempotent, cacheable.
 */
function info() {
  return {
    rune: {
      name: RUNE_NAME,
      symbol: RUNE_SYMBOL,
      divisibility: RUNE_DIVISIBILITY,
      total_supply: RUNE_TOTAL_SUPPLY,
      parcel_size: RUNE_PARCEL_SIZE,
      parcel_count: RUNE_PARCEL_COUNT,
    },
    pow: {
      algo: 'sha256',
      difficulty_bits: 14,
      challenge_endpoint: '/rune/challenge',
      claim_endpoint: '/rune/claim',
      hint: 'GET /rune/challenge issues a fresh PoW challenge. Solve it (SHA256(salt+nonce) leading 14 zero bits). POST /rune/claim with {id, salt, nonce, signature, recipient_address}.',
    },
    distribution: {
      model: 'off-chain-enforcement',
      premine_held_by: 'powforge-relay',
      claims_total: parcelsClaimed,
      claims_remaining: Math.max(0, RUNE_PARCEL_COUNT - parcelsClaimed),
      rate_limit: '1 claim per recipient address per 24h',
    },
    status: 'scaffold',
    next_milestone: 'phase-1 regtest validation — see research/rune-pow-fairlaunch-design.md',
    fairness_note:
      'This is off-chain enforcement. PowForge holds the keys and gates transfers behind PoW. ' +
      'Anyone who controls the relay key could bypass the PoW barrier. ' +
      'Mainnet etch will be gated behind 2-of-3 multisig before public claim window opens.',
  };
}

/**
 * Issue a PoW challenge. Thin pass-through to the existing captcha challenge
 * endpoint — we share the same SHA-256 14-bit primitive so we don't fork two
 * challenge formats. The challenge object is identical to the one returned by
 * GET /api/challenge on the captcha server.
 *
 * In a wired route handler this is implemented at the HTTP level: GET
 * /rune/challenge proxies to the existing generateChallenge() function in
 * scripts/pow-captcha-server.js. This function exists so callers can preflight
 * the challenge shape and difficulty programmatically.
 */
function challenge() {
  return {
    instructions:
      'GET /rune/challenge issues an HMAC-signed PoW challenge ' +
      '(same format as GET /api/challenge on captcha.powforge.dev). ' +
      'Brute-force a nonce string such that SHA-256(salt + nonce) ' +
      'has at least `difficulty` leading zero bits (default 14). ' +
      'Then POST /rune/claim with {id, salt, nonce, signature, recipient_address}.',
    algo: 'sha256',
    difficulty: 14,
    captcha_challenge_url:
      (process.env.CAPTCHA_URL || 'http://localhost:3077').replace(/\/+$/, '') +
      '/api/challenge',
    claim_url:
      (process.env.CAPTCHA_URL || 'http://localhost:3077').replace(/\/+$/, '') +
      '/rune/claim',
  };
}

/**
 * Verify a PoW solution AND a Bitcoin recipient address, then (eventually)
 * sign a Rune transfer transaction.
 *
 * Phase 1 (THIS SCAFFOLD): validates input contract, checks rate limit,
 * verifies PoW via captchaVerify(), reserves a parcel id, returns a
 * structured "coming-soon" stub with the eventual response shape documented.
 *
 * Phase 2 (next tick): swap the stub body for runestone-lib tx construction.
 * The function signature and return shape will not change.
 *
 * @param {object} input — { id, salt, nonce, signature, algo?, difficulty?, recipient_address }
 * @param {object} opts — { captchaVerifyImpl?, now?, fetchImpl? } for testability
 */
async function claim(input, opts = {}) {
  if (!input || typeof input !== 'object') {
    return { error: 'input_required', hint: 'pass {id, salt, nonce, signature, recipient_address}' };
  }
  const { recipient_address } = input;
  if (!recipient_address || typeof recipient_address !== 'string') {
    return { error: 'recipient_address_required', hint: 'Bitcoin mainnet P2WPKH/P2TR/P2PKH/P2SH address' };
  }
  if (!looksLikeBitcoinMainnetAddress(recipient_address)) {
    return {
      error: 'recipient_address_invalid',
      hint: 'Must be a Bitcoin mainnet address. bc1q... (P2WPKH), bc1p... (P2TR), 1... (P2PKH), or 3... (P2SH).',
    };
  }

  const now = (opts.now && typeof opts.now === 'function' ? opts.now() : Date.now());

  // Rate limit: 1 claim per recipient address per 24h
  const prior = claimsByAddress.get(recipient_address);
  if (prior && now - prior.claimed_at_ms < CLAIM_RATE_LIMIT_MS) {
    const wait_ms = CLAIM_RATE_LIMIT_MS - (now - prior.claimed_at_ms);
    return {
      error: 'rate_limit_per_address',
      retry_after_ms: wait_ms,
      retry_after_iso: new Date(now + wait_ms).toISOString(),
      prior_claim: { parcel_id: prior.parcel_id, claimed_at_iso: new Date(prior.claimed_at_ms).toISOString() },
      hint: 'Each Bitcoin address may claim one parcel per 24h. Try a different recipient or wait.',
    };
  }

  // Supply check
  if (parcelsClaimed >= RUNE_PARCEL_COUNT) {
    return {
      error: 'launch_exhausted',
      parcels_total: RUNE_PARCEL_COUNT,
      parcels_remaining: 0,
      hint: 'All 21,000 parcels of POWFORGE•PROOF have been claimed.',
    };
  }

  // Verify PoW via the captcha-mcp verify handler (shares the same primitive)
  const verifyImpl = opts.captchaVerifyImpl || captchaVerify;
  const pow = await verifyImpl(input, opts);
  if (!pow || !pow.valid) {
    return {
      error: 'pow_invalid',
      reason: (pow && (pow.reason || pow.error)) || 'verification_failed',
      hint: 'Re-solve the PoW challenge. SHA-256(salt+nonce) must have 14+ leading zero bits.',
    };
  }

  // Reserve a parcel — in production this consumes one relay UTXO from the
  // chained transfer ledger. Here we just bump an in-memory counter.
  const parcel_id = parcelsClaimed + 1;

  // SCAFFOLD STUB — in production this section calls into runestone-lib:
  //
  //   const { encodeRunestone } = require('@magiceden-oss/runestone-lib');
  //   const psbt = buildClaimPsbt({
  //     relay_utxo: relayCursor.next(),
  //     rune_id: RUNE_ID,
  //     amount: RUNE_PARCEL_SIZE,
  //     recipient: recipient_address,
  //     relay_change_address: RELAY_ADDRESS,
  //     fee_rate_sat_vb: feeRate,
  //   });
  //   return { txhex: psbt.toHex(), txid_will_be: ..., parcel_id, ... };
  //
  // Until then, return a stub that documents the missing pieces.

  parcelsClaimed += 1;
  claimsByAddress.set(recipient_address, {
    claimed_at_ms: now,
    parcel_id,
    txid: null, // populated once Phase 2 wires the real tx
  });

  return {
    status: 'coming-soon',
    parcel_id,
    parcel_size: RUNE_PARCEL_SIZE,
    rune: RUNE_NAME,
    recipient_address,
    pow_verified: true,
    pow_method: pow.method || 'pow',
    pow_token: pow.token, // pass through the captcha token in case caller wants to verify independently
    next_response_shape: {
      status: 'signed',
      txhex: '<hex-encoded signed Bitcoin transaction>',
      txid_will_be: '<32-byte sha256d of tx>',
      psbt: '<base64 PSBT (alternative path — claimer signs and broadcasts)>',
      runestone_payload: { edicts: [{ rune_id: '<block:tx>', amount: RUNE_PARCEL_SIZE, output: 0 }] },
      broadcast_endpoint: '/rune/broadcast (optional upsell tier, 21 sats L402)',
    },
    library_pending: '@magiceden-oss/runestone-lib (npm) — install in tick T+1',
    relay_key_pending: 'mainnet relay multisig — Fubz-gated, see design doc Risks §1',
    design_doc: 'research/rune-pow-fairlaunch-design.md',
    claims_total: parcelsClaimed,
    claims_remaining: RUNE_PARCEL_COUNT - parcelsClaimed,
  };
}

// =============================================================================
// TEST HOOKS — used by tests to reset state between cases
// =============================================================================

function _resetForTests() {
  claimsByAddress.clear();
  parcelsClaimed = 0;
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  info,
  challenge,
  claim,
  // private but exposed for tests
  _resetForTests,
  _looksLikeBitcoinMainnetAddress: looksLikeBitcoinMainnetAddress,
  // constants
  RUNE_NAME,
  RUNE_SYMBOL,
  RUNE_DIVISIBILITY,
  RUNE_TOTAL_SUPPLY,
  RUNE_PARCEL_SIZE,
  RUNE_PARCEL_COUNT,
  CLAIM_RATE_LIMIT_MS,
};
