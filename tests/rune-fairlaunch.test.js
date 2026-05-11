/**
 * @powforge/captcha-mcp — rune-fairlaunch scaffold tests.
 *
 * Validates the scaffold contract (input validation, rate limiting, PoW gating,
 * supply tracking) without spinning up Bitcoin tx construction. The "coming-soon"
 * stub response is asserted explicitly so we'll know when Phase 2 swaps in real
 * tx-building — these tests will need to be updated then, and that's intentional.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fairlaunch = require('../src/rune-fairlaunch.js');
const {
  info,
  challenge,
  claim,
  _resetForTests,
  _looksLikeBitcoinMainnetAddress: isBtcAddr,
  RUNE_NAME,
  RUNE_PARCEL_SIZE,
  RUNE_PARCEL_COUNT,
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
  assert.equal(r.status, 'scaffold');
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

test('claim returns coming-soon stub when PoW valid', async () => {
  _resetForTests();
  const r = await claim(
    {
      id: 'ch.1', salt: 'aabb', nonce: '12345', signature: 'sig',
      recipient_address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    },
    { captchaVerifyImpl: fakeVerifyOk }
  );
  assert.equal(r.status, 'coming-soon');
  assert.equal(r.parcel_id, 1);
  assert.equal(r.parcel_size, RUNE_PARCEL_SIZE);
  assert.equal(r.rune, RUNE_NAME);
  assert.equal(r.pow_verified, true);
  assert.equal(r.claims_total, 1);
  assert.equal(r.claims_remaining, RUNE_PARCEL_COUNT - 1);
  assert.ok(r.next_response_shape);
  assert.ok(r.next_response_shape.txhex);
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
  assert.equal(first.status, 'coming-soon');

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
  assert.equal(ok.status, 'coming-soon');
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
  assert.equal(ra.status, 'coming-soon');
  assert.equal(rb.status, 'coming-soon');
  assert.equal(ra.parcel_id, 1);
  assert.equal(rb.parcel_id, 2);
});
