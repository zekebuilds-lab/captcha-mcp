/**
 * @powforge/captcha-mcp — rune-fairlaunch Phase 2 tests.
 *
 * Validates: input validation, rate limiting, PoW gating, supply tracking,
 * AND Phase-2 Runestone encoding (real OP_RETURN scriptpubkey bytes that
 * round-trip through @magiceden-oss/runestone-lib's decoder).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tryDecodeRunestone } = require('@magiceden-oss/runestone-lib');

const fairlaunch = require('../src/rune-fairlaunch.js');
const {
  info,
  challenge,
  claim,
  encodeRunestoneEdict,
  encodeRunestoneEtching,
  _resetForTests,
  _looksLikeBitcoinMainnetAddress: isBtcAddr,
  RUNE_NAME,
  RUNE_RAW_NAME,
  RUNE_PARCEL_SIZE,
  RUNE_PARCEL_COUNT,
  RUNE_TOTAL_SUPPLY,
  CLAIM_RATE_LIMIT_MS,
} = fairlaunch;

// fakeVerify returns { valid: true } unconditionally — we test the PoW
// gate by switching to a verifier that rejects.
const fakeVerifyOk = async () => ({ valid: true, token: 'tok.fake', method: 'pow' });
const fakeVerifyBad = async () => ({ valid: false, reason: 'wrong_nonce' });

test('info returns rune config and current state', () => {
  _resetForTests();
  const r = info();
  assert.equal(r.rune.name, 'POWFORGE•PROOF');
  assert.equal(r.rune.parcel_size, 1000);
  assert.equal(r.rune.parcel_count, 21000);
  assert.equal(r.distribution.claims_total, 0);
  assert.equal(r.distribution.claims_remaining, 21000);
  assert.equal(r.status, 'phase-2-encoding');
});

test('challenge returns metadata pointing to captcha endpoint', () => {
  const r = challenge();
  assert.equal(r.algo, 'sha256');
  assert.equal(r.difficulty, 14);
  assert.match(r.captcha_challenge_url, /\/api\/challenge$/);
  assert.match(r.claim_url, /\/rune\/claim$/);
});

test('claim rejects missing input', async () => {
  _resetForTests();
  const r = await claim(null);
  assert.equal(r.error, 'input_required');
});

test('claim rejects missing recipient_address', async () => {
  _resetForTests();
  const r = await claim({ id: 'x', salt: 'y', nonce: 'z', signature: 'w' });
  assert.equal(r.error, 'recipient_address_required');
});

test('claim rejects invalid Bitcoin address', async () => {
  _resetForTests();
  const r = await claim({
    id: 'x', salt: 'y', nonce: 'z', signature: 'w',
    recipient_address: 'not-a-bitcoin-address',
  });
  assert.equal(r.error, 'recipient_address_invalid');
});

test('isBtcAddr accepts common Bitcoin mainnet address formats', () => {
  // P2WPKH (bech32)
  assert.ok(isBtcAddr('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'));
  // P2TR (bech32m)
  assert.ok(isBtcAddr('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'));
  // P2PKH legacy
  assert.ok(isBtcAddr('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'));
  // P2SH
  assert.ok(isBtcAddr('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'));
});

test('isBtcAddr rejects testnet, signet, regtest, and invalid prefixes', () => {
  assert.ok(!isBtcAddr('tb1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')); // testnet
  assert.ok(!isBtcAddr('bcrt1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')); // regtest
  assert.ok(!isBtcAddr('mvyM2Rd5XwxnP6yhJxgBnDb4yDw5Bh3K3X')); // testnet P2PKH
  assert.ok(!isBtcAddr('not-an-address'));
  assert.ok(!isBtcAddr(''));
  assert.ok(!isBtcAddr(null));
});

test('claim returns runestone-ready response with real OP_RETURN bytes when PoW valid', async () => {
  _resetForTests();
  const r = await claim(
    {
      id: 'ch.1', salt: 'aabb', nonce: '12345', signature: 'sig',
      recipient_address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    },
    { captchaVerifyImpl: fakeVerifyOk }
  );
  assert.equal(r.status, 'runestone-ready');
  assert.equal(r.parcel_id, 1);
  assert.equal(r.parcel_size, RUNE_PARCEL_SIZE);
  assert.equal(r.rune, RUNE_NAME);
  assert.equal(r.pow_verified, true);
  assert.equal(r.claims_total, 1);
  assert.equal(r.claims_remaining, RUNE_PARCEL_COUNT - 1);
  // Phase 2 deliverable: real Runestone bytes
  assert.ok(r.runestone, 'runestone field present');
  assert.match(r.runestone.scriptpubkey_hex, /^[0-9a-f]+$/, 'scriptpubkey is hex');
  assert.ok(r.runestone.scriptpubkey_hex.startsWith('6a5d'), 'starts with OP_RETURN + OP_13 (Runestone magic)');
  assert.equal(r.runestone.scriptpubkey_len, r.runestone.scriptpubkey_hex.length / 2);
  assert.equal(r.runestone.edicts.length, 1);
  assert.equal(r.runestone.edicts[0].amount, RUNE_PARCEL_SIZE);
  assert.equal(r.runestone.edicts[0].output, 0);
  // Transfer tx template documents what phase 3 will sign
  assert.ok(r.transfer_tx_template);
  assert.equal(r.transfer_tx_template.outputs.length, 3);
  assert.equal(r.transfer_tx_template.outputs[0].address, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
  assert.match(r.design_doc, /rune-pow-fairlaunch-design\.md$/);
});

test('claim rejects when PoW verify fails', async () => {
  _resetForTests();
  const r = await claim(
    {
      id: 'ch.1', salt: 'aabb', nonce: 'wrong', signature: 'sig',
      recipient_address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    },
    { captchaVerifyImpl: fakeVerifyBad }
  );
  assert.equal(r.error, 'pow_invalid');
  assert.equal(r.reason, 'wrong_nonce');
});

test('claim enforces 24h rate limit per recipient address', async () => {
  _resetForTests();
  const addr = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  const t0 = 1_700_000_000_000;

  const first = await claim(
    { id: 'ch.1', salt: 'a', nonce: '1', signature: 's', recipient_address: addr },
    { captchaVerifyImpl: fakeVerifyOk, now: () => t0 }
  );
  assert.equal(first.status, 'runestone-ready');

  // 12h later — still inside rate window
  const tooSoon = await claim(
    { id: 'ch.2', salt: 'b', nonce: '2', signature: 's', recipient_address: addr },
    { captchaVerifyImpl: fakeVerifyOk, now: () => t0 + 12 * 3600 * 1000 }
  );
  assert.equal(tooSoon.error, 'rate_limit_per_address');
  assert.ok(tooSoon.retry_after_ms > 0);
  assert.ok(tooSoon.retry_after_ms <= CLAIM_RATE_LIMIT_MS);

  // 25h later — outside rate window
  const ok = await claim(
    { id: 'ch.3', salt: 'c', nonce: '3', signature: 's', recipient_address: addr },
    { captchaVerifyImpl: fakeVerifyOk, now: () => t0 + 25 * 3600 * 1000 }
  );
  assert.equal(ok.status, 'runestone-ready');
  assert.equal(ok.parcel_id, 2);
});

test('different addresses do not share the rate limit', async () => {
  _resetForTests();
  const a = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  const b = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
  const t0 = 1_700_000_000_000;
  const ra = await claim(
    { id: 'ch.1', salt: 'a', nonce: '1', signature: 's', recipient_address: a },
    { captchaVerifyImpl: fakeVerifyOk, now: () => t0 }
  );
  const rb = await claim(
    { id: 'ch.2', salt: 'b', nonce: '2', signature: 's', recipient_address: b },
    { captchaVerifyImpl: fakeVerifyOk, now: () => t0 + 1000 }
  );
  assert.equal(ra.status, 'runestone-ready');
  assert.equal(rb.status, 'runestone-ready');
  assert.equal(ra.parcel_id, 1);
  assert.equal(rb.parcel_id, 2);
});

// =============================================================================
// Phase 2 — Runestone encoding tests
// =============================================================================

test('encodeRunestoneEdict produces valid OP_RETURN scriptpubkey starting with 6a5d', () => {
  const buf = encodeRunestoneEdict({
    runeId: { block: 840000n, tx: 1 },
    amount: 1000,
    output: 0,
  });
  assert.ok(Buffer.isBuffer(buf), 'returns a Buffer');
  assert.ok(buf.length >= 4, 'has at least magic + length + payload');
  assert.equal(buf[0], 0x6a, 'first byte is OP_RETURN (0x6a)');
  assert.equal(buf[1], 0x5d, 'second byte is OP_13 (0x5d, Runestone magic)');
});

test('encodeRunestoneEdict output round-trips through tryDecodeRunestone', () => {
  const runeId = { block: 840000n, tx: 1 };
  const buf = encodeRunestoneEdict({ runeId, amount: 1000, output: 0 });
  // Simulate a tx with one output whose scriptpubkey is our Runestone
  const fakeTx = {
    vout: [{ scriptPubKey: { hex: buf.toString('hex') } }],
  };
  const decoded = tryDecodeRunestone(fakeTx);
  assert.ok(decoded, 'decoder returned non-null');
  assert.ok(decoded.edicts, 'decoded as a Runestone with edicts');
  assert.equal(decoded.edicts.length, 1, 'one edict');
  assert.equal(decoded.edicts[0].amount, 1000n, 'amount matches');
  assert.equal(decoded.edicts[0].output, 0, 'output matches');
  assert.equal(decoded.edicts[0].id.block, 840000n, 'rune block matches');
  assert.equal(decoded.edicts[0].id.tx, 1, 'rune tx matches');
});

test('encodeRunestoneEdict rejects invalid runeId', () => {
  assert.throws(() => encodeRunestoneEdict({ runeId: null, amount: 1, output: 0 }), /runeId/);
  assert.throws(() => encodeRunestoneEdict({ runeId: { block: 1, tx: 1 }, amount: 1, output: 0 }), /runeId/);
});

test('encodeRunestoneEtching produces scriptpubkey with Runestone magic and a commitment', () => {
  const { scriptpubkey, commitment } = encodeRunestoneEtching();
  assert.ok(Buffer.isBuffer(scriptpubkey));
  assert.equal(scriptpubkey[0], 0x6a, 'OP_RETURN');
  assert.equal(scriptpubkey[1], 0x5d, 'OP_13 Runestone magic');
  // Etching commitment is the rune-name commitment that must appear in a
  // witness of the etching tx. Should be a Buffer.
  assert.ok(Buffer.isBuffer(commitment), 'commitment is Buffer');
  assert.ok(commitment.length > 0, 'commitment is non-empty');
});

test('encodeRunestoneEtching with POWFORGE config encodes the full premine', () => {
  const { scriptpubkey } = encodeRunestoneEtching();
  // Round-trip via tryDecodeRunestone — the etching field should be present
  const fakeTx = { vout: [{ scriptPubKey: { hex: scriptpubkey.toString('hex') } }] };
  const decoded = tryDecodeRunestone(fakeTx);
  assert.ok(decoded, 'decoded non-null');
  assert.ok(decoded.etching, 'has etching field');
  assert.equal(decoded.etching.premine, BigInt(RUNE_TOTAL_SUPPLY), 'premine matches RUNE_TOTAL_SUPPLY');
  assert.equal(decoded.etching.divisibility, 0, 'divisibility 0');
  assert.equal(decoded.etching.symbol, '⚒', 'symbol is hammer');
});

test('claim accepts custom runeId via opts.runeId for testing', async () => {
  _resetForTests();
  const r = await claim(
    {
      id: 'ch.1', salt: 'a', nonce: '1', signature: 's',
      recipient_address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    },
    {
      captchaVerifyImpl: fakeVerifyOk,
      runeId: { block: 850000n, tx: 42 },
    }
  );
  assert.equal(r.status, 'runestone-ready');
  assert.equal(r.rune_id.block, '850000');
  assert.equal(r.rune_id.tx, 42);
  // Verify decoded edict uses the custom runeId
  const hex = r.runestone.scriptpubkey_hex;
  const decoded = tryDecodeRunestone({ vout: [{ scriptPubKey: { hex } }] });
  assert.equal(decoded.edicts[0].id.block, 850000n);
  assert.equal(decoded.edicts[0].id.tx, 42);
});
