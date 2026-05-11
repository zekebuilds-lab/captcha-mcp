/**
 * @powforge/captcha-mcp — rune-broadcast Phase 3a tests.
 *
 * Validates: PSBT construction with @scure/btc-signer, round-trip parse,
 * UTXO selection, and mempool.space fetch error handling. No network in
 * the test path — fetchImpl is injected.
 *
 * The key assertion: a PSBT we produce must parse back through
 * Transaction.fromPSBT() with input/output counts intact and the OP_RETURN
 * Runestone (prefix 6a 5d) preserved at output 0.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const btc = require('@scure/btc-signer');
const { schnorr } = require('@noble/curves/secp256k1.js');

const {
  fetchUtxosFromMempoolSpace,
  pickLargestUtxo,
  buildRuneTransferPsbt,
  assertPsbtRoundTrip,
} = require('../src/rune-broadcast.js');
const { encodeRunestoneEdict } = require('../src/rune-fairlaunch.js');

// =============================================================================
// FIXTURES
// =============================================================================

// Deterministic internal key (x-only pubkey) for tests. We derive a real
// Schnorr x-only pubkey from a SHA-256 of a label so that btc.p2tr accepts
// it. NOT a real key — just deterministic fixture bytes that produce a
// valid x-only pubkey on the secp256k1 curve.
function fixtureInternalKey() {
  const priv = new Uint8Array(crypto.createHash('sha256').update('powforge-rune-test-key').digest());
  return schnorr.getPublicKey(priv);
}

function fixtureRunestoneBytes() {
  return encodeRunestoneEdict({
    runeId: { block: 840000n, tx: 1 },
    amount: 1000,
    output: 1,
  });
}

// Deterministic recipient P2TR address — derived from a second fixture
// key so the address checksum is valid. Cached at module load.
function fixtureRecipientAddress() {
  const priv = new Uint8Array(crypto.createHash('sha256').update('powforge-rune-recipient-test').digest());
  const xonly = schnorr.getPublicKey(priv);
  return btc.p2tr(xonly, undefined, btc.NETWORK).address;
}

function fixtureUtxo(value = 10_000) {
  return {
    txid: 'a'.repeat(64),
    vout: 0,
    value,
    status: { confirmed: true, block_height: 950000 },
  };
}

// =============================================================================
// UTXO fetch (with injected fetchImpl — no network)
// =============================================================================

test('fetchUtxosFromMempoolSpace: returns confirmed UTXOs by default', async () => {
  const fakeUtxos = [
    { txid: 'a'.repeat(64), vout: 0, value: 5000, status: { confirmed: true } },
    { txid: 'b'.repeat(64), vout: 1, value: 8000, status: { confirmed: false } },
    { txid: 'c'.repeat(64), vout: 0, value: 12000, status: { confirmed: true } },
  ];
  const fakeFetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => fakeUtxos,
  });
  const utxos = await fetchUtxosFromMempoolSpace('bc1ptestaddress1234567', { fetchImpl: fakeFetch });
  assert.equal(utxos.length, 2);
  assert.ok(utxos.every((u) => u.status.confirmed === true));
});

test('fetchUtxosFromMempoolSpace: confirmedOnly=false returns all', async () => {
  const fakeUtxos = [
    { txid: 'a'.repeat(64), vout: 0, value: 5000, status: { confirmed: true } },
    { txid: 'b'.repeat(64), vout: 1, value: 8000, status: { confirmed: false } },
  ];
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => fakeUtxos });
  const utxos = await fetchUtxosFromMempoolSpace('bc1ptestaddress1234567', { fetchImpl: fakeFetch, confirmedOnly: false });
  assert.equal(utxos.length, 2);
});

test('fetchUtxosFromMempoolSpace: throws on HTTP error', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500 });
  await assert.rejects(
    () => fetchUtxosFromMempoolSpace('bc1ptestaddress1234567', { fetchImpl: fakeFetch }),
    /HTTP 500/
  );
});

test('fetchUtxosFromMempoolSpace: rejects missing address', async () => {
  await assert.rejects(
    () => fetchUtxosFromMempoolSpace(undefined, { fetchImpl: async () => ({}) }),
    /address required/
  );
});

test('pickLargestUtxo: picks max-value entry', () => {
  const utxos = [
    { txid: 'a', vout: 0, value: 1000 },
    { txid: 'b', vout: 0, value: 5000 },
    { txid: 'c', vout: 0, value: 2000 },
  ];
  const pick = pickLargestUtxo(utxos);
  assert.equal(pick.value, 5000);
  assert.equal(pick.txid, 'b');
});

test('pickLargestUtxo: returns null for empty list', () => {
  assert.equal(pickLargestUtxo([]), null);
  assert.equal(pickLargestUtxo(null), null);
});

// =============================================================================
// PSBT construction
// =============================================================================

test('buildRuneTransferPsbt: produces valid PSBT bytes', () => {
  const internalKey = fixtureInternalKey();
  const runestoneBytes = fixtureRunestoneBytes();
  // Derive the relay's own P2TR address from the internal key
  const relay = btc.p2tr(internalKey, undefined, btc.NETWORK);
  const result = buildRuneTransferPsbt({
    utxo: fixtureUtxo(10_000),
    runestoneScriptpubkey: runestoneBytes,
    recipientAddress: fixtureRecipientAddress(), // any valid mainnet P2TR
    changeAddress: relay.address,
    internalKey,
    feeRate: 2,
  });
  assert.ok(result.psbtBytes instanceof Uint8Array);
  assert.ok(result.psbtBytes.length > 50, 'PSBT should be non-trivial size');
  assert.ok(result.psbtBase64.length > 0);
  assert.ok(result.estimatedVbytes >= 160 && result.estimatedVbytes <= 200, `vbytes ${result.estimatedVbytes} out of expected range`);
  assert.ok(result.feeSats > 0);
  assert.equal(result.changeSats, 10_000 - 546 - result.feeSats);
});

test('buildRuneTransferPsbt: round-trips through Transaction.fromPSBT', () => {
  const internalKey = fixtureInternalKey();
  const runestoneBytes = fixtureRunestoneBytes();
  const relay = btc.p2tr(internalKey, undefined, btc.NETWORK);
  const result = buildRuneTransferPsbt({
    utxo: fixtureUtxo(10_000),
    runestoneScriptpubkey: runestoneBytes,
    recipientAddress: fixtureRecipientAddress(),
    changeAddress: relay.address,
    internalKey,
    feeRate: 2,
  });
  const check = assertPsbtRoundTrip(result.psbtBytes, {
    inputCount: 1,
    outputCount: 3,
    expectRunestone: true,
  });
  assert.equal(check.inputCount, 1);
  assert.equal(check.outputCount, 3);
  assert.ok(check.runestoneFound, 'Runestone OP_RETURN must survive round-trip');
  // Output 0 must be the Runestone (zero value)
  assert.equal(check.outputAmounts[0], 0n);
  // Output 1 is the recipient dust
  assert.equal(check.outputAmounts[1], 546n);
  // Output 2 is the change
  assert.equal(check.outputAmounts[2], BigInt(result.changeSats));
});

test('buildRuneTransferPsbt: rejects under-funded UTXO', () => {
  const internalKey = fixtureInternalKey();
  const runestoneBytes = fixtureRunestoneBytes();
  const relay = btc.p2tr(internalKey, undefined, btc.NETWORK);
  assert.throws(
    () =>
      buildRuneTransferPsbt({
        utxo: fixtureUtxo(800), // too small to leave change above dust
        runestoneScriptpubkey: runestoneBytes,
        recipientAddress: fixtureRecipientAddress(),
        changeAddress: relay.address,
        internalKey,
        feeRate: 2,
      }),
    /below dust limit/
  );
});

test('buildRuneTransferPsbt: rejects bad input shape', () => {
  const internalKey = fixtureInternalKey();
  assert.throws(
    () =>
      buildRuneTransferPsbt({
        utxo: { txid: 'bad' }, // missing vout, value
        runestoneScriptpubkey: fixtureRunestoneBytes(),
        recipientAddress: fixtureRecipientAddress(),
        changeAddress: fixtureRecipientAddress(),
        internalKey,
      }),
    /utxo must be/
  );
});

test('buildRuneTransferPsbt: rejects wrong-length internal key', () => {
  assert.throws(
    () =>
      buildRuneTransferPsbt({
        utxo: fixtureUtxo(),
        runestoneScriptpubkey: fixtureRunestoneBytes(),
        recipientAddress: fixtureRecipientAddress(),
        changeAddress: fixtureRecipientAddress(),
        internalKey: new Uint8Array(16), // wrong length
      }),
    /32-byte/
  );
});

test('buildRuneTransferPsbt: higher feeRate produces higher feeSats', () => {
  const internalKey = fixtureInternalKey();
  const runestoneBytes = fixtureRunestoneBytes();
  const relay = btc.p2tr(internalKey, undefined, btc.NETWORK);
  const args = {
    utxo: fixtureUtxo(20_000),
    runestoneScriptpubkey: runestoneBytes,
    recipientAddress: fixtureRecipientAddress(),
    changeAddress: relay.address,
    internalKey,
  };
  const low = buildRuneTransferPsbt({ ...args, feeRate: 2 });
  const high = buildRuneTransferPsbt({ ...args, feeRate: 10 });
  assert.ok(high.feeSats > low.feeSats);
  assert.equal(high.changeSats, 20_000 - 546 - high.feeSats);
});
