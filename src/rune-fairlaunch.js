/**
 * @powforge/captcha-mcp — Rune PoW Fair-Launch (Phase 2: Runestone encoding)
 *
 * Tick 545, build/141 phase 2 (research/rune-pow-fairlaunch-design.md).
 *
 * Off-chain enforcement model: PowForge etches a Rune with premine = total
 * supply, then gates transfers behind the existing pow-captcha PoW challenge.
 * Solve the PoW, supply a Bitcoin recipient address, get back a Runestone
 * OP_RETURN payload + transfer template the caller can broadcast (PSBT flow
 * lands phase 3 once relay UTXO cursor is wired up).
 *
 * What Phase 2 ships:
 *   • encodeRunestoneEdict({ runeId, amount, output }) -> Buffer of the
 *     OP_RETURN scriptpubkey (6a 5d <varint-encoded edict>).
 *   • encodeRunestoneEtching(spec) -> { scriptpubkey, commitment } for the
 *     POWFORGE•PROOF etching tx.
 *   • claim() now returns a real `runestone_scriptpubkey` hex (from
 *     @magiceden-oss/runestone-lib) plus the transfer-tx template fields the
 *     caller (or phase-3 broadcaster) needs to finalize the tx.
 *
 * What Phase 3 will add (NOT in this file):
 *   • Relay UTXO cursor (chain forward each claim's leftover balance).
 *   • bitcoinjs-lib PSBT assembly + relay signature.
 *   • Broadcast endpoint hitting lightning.lan:8332 sendrawtransaction.
 *
 * The route shape, return contract, error codes, and rate-limit semantics from
 * the Phase-1 scaffold are STABLE. Phase 2 enriches the response with real
 * Runestone bytes; it does not change error codes or status semantics.
 */

'use strict';

const crypto = require('crypto');
const { verify: captchaVerify } = require('./index.js');
const { encodeRunestone } = require('@magiceden-oss/runestone-lib');

// =============================================================================
// CONSTANTS — match design doc §"Rune configuration"
// =============================================================================

const RUNE_NAME = 'POWFORGE•PROOF';
const RUNE_RAW_NAME = 'POWFORGEPROOF';      // dots stripped — etcher spec
const RUNE_SPACERS = [8];                    // bitfield: spacer between POWFORGE and PROOF
const RUNE_SYMBOL = '⚒';
const RUNE_DIVISIBILITY = 0;
const RUNE_TOTAL_SUPPLY = 21_000_000;
const RUNE_PARCEL_SIZE = 1_000;
const RUNE_PARCEL_COUNT = RUNE_TOTAL_SUPPLY / RUNE_PARCEL_SIZE; // 21,000

// Per-recipient rate limit: 1 claim per address per 24h
const CLAIM_RATE_LIMIT_MS = 24 * 60 * 60 * 1000;

// Default rune location to use for transfer edicts until the live etch is
// performed on signet/mainnet. Tests assert this is overrideable via env so
// CI never needs a real on-chain etch. Format: <block>:<tx>.
function getRuneId() {
  const raw = process.env.POWFORGE_RUNE_ID;
  if (raw && /^\d+:\d+$/.test(raw)) {
    const [block, tx] = raw.split(':');
    return { block: BigInt(block), tx: Number(tx) };
  }
  // Sentinel rune id used for scaffold tests + Phase-2 encoding round-trips.
  // Replaced with real (block, tx) of the etching tx on signet/mainnet.
  return { block: 840000n, tx: 1 };
}

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
// RUNESTONE ENCODING (Phase 2)
// =============================================================================

/**
 * Encode a single-edict Rune transfer payload — the OP_RETURN scriptpubkey
 * that pays `amount` units of `runeId` to transaction output `output`.
 *
 * Returns a Buffer of the full scriptpubkey: `OP_RETURN(0x6a) + OP_13(0x5d)
 * + push(length) + varint-encoded edict tuple`. This is exactly what the
 * indexer (ord, magic eden's runestone-lib decoder, runelib) parses to assign
 * Rune balances post-confirmation.
 *
 * The bytes round-trip through `tryDecodeRunestone` from the same library —
 * tests assert the decoded edicts match what we encoded.
 *
 * @param {object} args
 * @param {{block: bigint, tx: number}} args.runeId  Rune location (block:tx of etch).
 * @param {bigint|number} args.amount                Units to transfer.
 * @param {number} args.output                       Output index that receives the rune.
 * @returns {Buffer}                                 Full scriptpubkey bytes.
 */
function encodeRunestoneEdict({ runeId, amount, output }) {
  if (!runeId || typeof runeId.block !== 'bigint' || typeof runeId.tx !== 'number') {
    throw new Error('encodeRunestoneEdict: runeId must be { block: bigint, tx: number }');
  }
  if (amount == null) throw new Error('encodeRunestoneEdict: amount required');
  if (output == null || output < 0) throw new Error('encodeRunestoneEdict: output index required');
  const amt = typeof amount === 'bigint' ? amount : BigInt(amount);
  const { encodedRunestone } = encodeRunestone({
    edicts: [{ id: runeId, amount: amt, output: Number(output) }],
  });
  return encodedRunestone;
}

/**
 * Encode the POWFORGE•PROOF etching scriptpubkey. One-shot — used once at
 * launch to mint the entire premine to the relay's address.
 *
 * Returns the scriptpubkey Buffer AND the etching commitment (Buffer of the
 * rune-name commitment that must appear in a witness of the etching tx per
 * the Runes spec — `tryDecodeRunestone` verifies this commitment on indexers).
 *
 * @param {object} [overrides]  Optional fields for testing variants.
 * @returns {{ scriptpubkey: Buffer, commitment: Buffer|undefined }}
 */
function encodeRunestoneEtching(overrides = {}) {
  const spec = {
    etching: {
      runeName: overrides.runeName || RUNE_RAW_NAME,
      divisibility: overrides.divisibility ?? RUNE_DIVISIBILITY,
      premine: overrides.premine != null ? BigInt(overrides.premine) : BigInt(RUNE_TOTAL_SUPPLY),
      symbol: overrides.symbol || RUNE_SYMBOL,
      spacers: overrides.spacers || RUNE_SPACERS,
    },
  };
  const { encodedRunestone, etchingCommitment } = encodeRunestone(spec);
  return { scriptpubkey: encodedRunestone, commitment: etchingCommitment };
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
    status: 'phase-2-encoding',
    next_milestone: 'phase-3: relay UTXO cursor + PSBT signing + signet broadcast — see research/rune-pow-fairlaunch-design.md',
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

  // Phase 2: build the real Runestone OP_RETURN scriptpubkey via
  // @magiceden-oss/runestone-lib. The edict sends RUNE_PARCEL_SIZE units of
  // POWFORGE•PROOF to output 0 (the claimer's address). The remainder of the
  // relay balance lands on output 1 (the relay change address) once Phase 3
  // wires the UTXO cursor.
  const runeId = (opts.runeId && typeof opts.runeId === 'object') ? opts.runeId : getRuneId();
  let runestoneScriptpubkey;
  try {
    runestoneScriptpubkey = encodeRunestoneEdict({
      runeId,
      amount: RUNE_PARCEL_SIZE,
      output: 0,
    });
  } catch (e) {
    return {
      error: 'runestone_encoding_failed',
      reason: e.message,
      hint: 'Internal: failed to encode the Runestone OP_RETURN. Report this — should never happen on valid input.',
    };
  }

  parcelsClaimed += 1;
  claimsByAddress.set(recipient_address, {
    claimed_at_ms: now,
    parcel_id,
    txid: null, // populated once Phase 3 wires broadcast
  });

  return {
    status: 'runestone-ready',
    parcel_id,
    parcel_size: RUNE_PARCEL_SIZE,
    rune: RUNE_NAME,
    rune_id: { block: runeId.block.toString(), tx: runeId.tx },
    recipient_address,
    pow_verified: true,
    pow_method: pow.method || 'pow',
    pow_token: pow.token, // pass through the captcha token so caller can verify independently
    // Phase 2 deliverable: real Runestone bytes the caller (or phase-3 relay)
    // can drop straight into a Bitcoin transaction.
    runestone: {
      scriptpubkey_hex: runestoneScriptpubkey.toString('hex'),
      scriptpubkey_len: runestoneScriptpubkey.length,
      edicts: [
        { rune_id: `${runeId.block}:${runeId.tx}`, amount: RUNE_PARCEL_SIZE, output: 0 },
      ],
    },
    transfer_tx_template: {
      // Caller assembles a tx with these outputs in order. Outputs 0 and 1 are
      // dust (546 sats minimum standardness). Output 2 carries the Runestone.
      outputs: [
        { description: 'dust to claimer (receives 1,000 RUNE via edict)', address: recipient_address, value_sats: 546 },
        { description: 'dust to relay change (receives the remainder)', address: '<relay_change_address>', value_sats: 546 },
        { description: 'OP_RETURN Runestone', scriptpubkey_hex: runestoneScriptpubkey.toString('hex'), value_sats: 0 },
      ],
      relay_input_needed: true,
      next_step: 'Phase 3 wires the relay UTXO cursor + PSBT signing. For now, callers can broadcast this Runestone in their own tx structure if they have a runestone-aware wallet.',
    },
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
  // Phase-2 encoding primitives
  encodeRunestoneEdict,
  encodeRunestoneEtching,
  // private but exposed for tests
  _resetForTests,
  _looksLikeBitcoinMainnetAddress: looksLikeBitcoinMainnetAddress,
  _getRuneId: getRuneId,
  // constants
  RUNE_NAME,
  RUNE_RAW_NAME,
  RUNE_SPACERS,
  RUNE_SYMBOL,
  RUNE_DIVISIBILITY,
  RUNE_TOTAL_SUPPLY,
  RUNE_PARCEL_SIZE,
  RUNE_PARCEL_COUNT,
  CLAIM_RATE_LIMIT_MS,
};
