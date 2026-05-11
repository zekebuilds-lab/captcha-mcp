/**
 * @powforge/captcha-mcp — Rune Phase 3a (PSBT builder)
 *
 * Tick 548, build/142 phase 3a. Phase 1 (scaffold) shipped MR !396.
 * Phase 2 (real Runestone bytes) shipped MR !397. This module adds:
 *
 *   • fetchUtxosFromMempoolSpace(address) — read UTXOs for a P2TR address
 *     via the public mempool.space REST API (no Bitcoin Core RPC needed).
 *   • buildRuneTransferPsbt({ utxo, runestoneScriptpubkey, recipientAddress,
 *     changeAddress, feeRate, internalKey }) — assemble an unsigned PSBT
 *     using @scure/btc-signer that transfers one parcel of POWFORGE•PROOF
 *     to recipientAddress with the change UTXO holding the relay's remaining
 *     supply.
 *   • assertPsbtRoundTrip(psbtBase64) — sanity check that the produced PSBT
 *     parses back through Transaction.fromPSBT() with all inputs+outputs
 *     preserved.
 *
 * Phase 3b (next tick) wires:
 *   • signing with the minting key
 *   • sendrawtransaction broadcast via lightning.lan:8332 (RPC permission
 *     confirmed tick 547) with mempool.space fallback
 *
 * Design rationale (research/tick-546-rune-phase3-prerequisites.md):
 *   • PSBT lib = @scure/btc-signer 2.2.0 (same author family as @noble/*
 *     already in the tree, two-package dep footprint).
 *   • allowUnknownOutputs: true because btc-signer rejects OP_RETURN by
 *     default; Runestone is OP_RETURN-by-design.
 *   • Output layout per the phase-2 transfer template:
 *       0 = OP_RETURN Runestone (value=0)
 *       1 = recipient P2TR (value=546 sats dust)
 *       2 = relay-change P2TR (value=funding - 546 - fee)
 *     This is the canonical "edict points at output 1" layout that ord and
 *     runestone-lib both parse cleanly. Output 0 first means low-fee filters
 *     do not strip the data carrier.
 */

'use strict';

const btc = require('@scure/btc-signer');

// =============================================================================
// MEMPOOL.SPACE UTXO FETCH
// =============================================================================

const MEMPOOL_API_BASE = 'https://mempool.space/api';

/**
 * Fetch UTXOs for a Bitcoin mainnet address from mempool.space. Returns the
 * raw UTXO list shape mempool.space publishes:
 *   [{ txid: hex, vout: number, value: satsNumber, status: {...} }, ...]
 *
 * The status field carries confirmed/block_height/block_hash/block_time. We
 * filter to confirmed UTXOs only by default (an unconfirmed UTXO is not safe
 * to spend in a tx the relay will broadcast).
 *
 * Throws on network error or non-200 status. Returns [] when the address has
 * no UTXOs (mempool.space returns an empty array for a fresh address).
 *
 * @param {string} address — Bitcoin mainnet address (P2TR, P2WPKH, P2PKH, P2SH).
 * @param {object} [opts]
 * @param {boolean} [opts.confirmedOnly=true] — filter to confirmed UTXOs.
 * @param {Function} [opts.fetchImpl=globalThis.fetch] — fetch override for tests.
 * @returns {Promise<Array>}
 */
async function fetchUtxosFromMempoolSpace(address, opts = {}) {
  if (typeof address !== 'string' || address.length < 10) {
    throw new Error('fetchUtxosFromMempoolSpace: address required');
  }
  const confirmedOnly = opts.confirmedOnly !== false;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchUtxosFromMempoolSpace: fetch implementation required (Node 18+ or pass opts.fetchImpl)');
  }
  const url = `${MEMPOOL_API_BASE}/address/${encodeURIComponent(address)}/utxo`;
  const res = await fetchImpl(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) {
    throw new Error(`fetchUtxosFromMempoolSpace: HTTP ${res.status} for ${address}`);
  }
  const utxos = await res.json();
  if (!Array.isArray(utxos)) {
    throw new Error('fetchUtxosFromMempoolSpace: expected array response');
  }
  if (!confirmedOnly) return utxos;
  return utxos.filter((u) => u && u.status && u.status.confirmed === true);
}

/**
 * Pick the largest confirmed UTXO from a list — the most-balance-per-input
 * strategy that suits the chained-relay model (we want the head UTXO that
 * carries the running balance of the launch).
 *
 * @param {Array} utxos — output of fetchUtxosFromMempoolSpace.
 * @returns {object|null} — largest UTXO or null when list is empty.
 */
function pickLargestUtxo(utxos) {
  if (!Array.isArray(utxos) || utxos.length === 0) return null;
  return utxos.reduce((best, cur) => {
    if (!best) return cur;
    return cur.value > best.value ? cur : best;
  }, null);
}

// =============================================================================
// PSBT CONSTRUCTION
// =============================================================================

/**
 * Build an unsigned PSBT that transfers one Rune parcel.
 *
 * Output layout (canonical for ord + runestone-lib):
 *   • Output 0: OP_RETURN Runestone (0 sats)
 *   • Output 1: recipient P2TR address (546 sats dust — receives parcel)
 *   • Output 2: relay change P2TR (remainder = utxo.value - 546 - fee)
 *
 * The Runestone edict in the OP_RETURN bytes MUST point at output 1 (the
 * recipient). The runestone-lib encoder produced that exact assignment via
 * encodeRunestoneEdict({ output: 1, ... }) — DO NOT override that here.
 *
 * @param {object} args
 * @param {object} args.utxo — { txid, vout, value, scriptPubKey?: hex string }
 * @param {Buffer} args.runestoneScriptpubkey — output of encodeRunestoneEdict()
 * @param {string} args.recipientAddress — mainnet bech32/legacy address
 * @param {string} args.changeAddress — relay's own change address (typically
 *   the same address as the input UTXO when chaining the relay cursor)
 * @param {Uint8Array} args.internalKey — 32-byte x-only pubkey for the
 *   input's P2TR witness (Taproot key-path spend). Used to derive the
 *   witnessUtxo.script for signing.
 * @param {number} [args.feeRate=2] — sats per vbyte. 2 is the post-2024
 *   "low priority" rate that confirms within ~24h. Bump for urgency.
 * @param {number} [args.dustLimit=546] — output 1 value in sats.
 * @returns {{ psbtBase64: string, psbtHex: string, txBytes: Uint8Array,
 *   estimatedVbytes: number, feeSats: number, changeSats: number }}
 */
function buildRuneTransferPsbt({
  utxo,
  runestoneScriptpubkey,
  recipientAddress,
  changeAddress,
  internalKey,
  feeRate = 2,
  dustLimit = 546,
}) {
  // -- input validation
  if (!utxo || typeof utxo.txid !== 'string' || typeof utxo.vout !== 'number' || typeof utxo.value !== 'number') {
    throw new Error('buildRuneTransferPsbt: utxo must be { txid, vout, value }');
  }
  if (!Buffer.isBuffer(runestoneScriptpubkey) && !(runestoneScriptpubkey instanceof Uint8Array)) {
    throw new Error('buildRuneTransferPsbt: runestoneScriptpubkey must be Buffer/Uint8Array');
  }
  if (typeof recipientAddress !== 'string' || recipientAddress.length < 10) {
    throw new Error('buildRuneTransferPsbt: recipientAddress required');
  }
  if (typeof changeAddress !== 'string' || changeAddress.length < 10) {
    throw new Error('buildRuneTransferPsbt: changeAddress required');
  }
  if (!(internalKey instanceof Uint8Array) || internalKey.length !== 32) {
    throw new Error('buildRuneTransferPsbt: internalKey must be 32-byte Uint8Array (x-only pubkey)');
  }

  // -- vbyte estimate for fee budgeting
  // Transfer relay tx shape per research/tick-546-rune-phase3-prerequisites.md §3:
  //   1 P2TR input (key-path Schnorr) ≈ 57.5 vbytes
  //   OP_RETURN Runestone output ≈ 10 + payload bytes
  //   2 × P2TR output ≈ 43 vbytes each
  //   Tx overhead ≈ 10.5 vbytes
  // Total ≈ 164 vbytes for a typical edict.
  const runestoneBytes = runestoneScriptpubkey.length;
  const estimatedVbytes = 10 + 58 + (10 + runestoneBytes) + 43 + 43;
  const feeSats = Math.ceil(estimatedVbytes * feeRate);
  const changeSats = utxo.value - dustLimit - feeSats;

  if (changeSats < dustLimit) {
    throw new Error(
      `buildRuneTransferPsbt: change ${changeSats} sats below dust limit ${dustLimit} ` +
      `(input ${utxo.value}, dust ${dustLimit}, fee ${feeSats}). Top up the relay UTXO or lower feeRate.`
    );
  }

  // -- build the P2TR script for the input's witnessUtxo
  // btc-signer's p2tr(internalKey) returns { script, address, ... }
  const inputP2tr = btc.p2tr(internalKey, undefined, btc.NETWORK);

  // -- assemble PSBT
  // allowUnknownOutputs: true is required because btc-signer rejects
  // OP_RETURN scripts by default as a footgun-prevention measure. Runestone
  // IS an OP_RETURN, so we explicitly opt in.
  const tx = new btc.Transaction({ allowUnknownOutputs: true });

  tx.addInput({
    txid: utxo.txid,
    index: utxo.vout,
    witnessUtxo: {
      script: inputP2tr.script,
      amount: BigInt(utxo.value),
    },
    tapInternalKey: internalKey,
  });

  // Output 0: OP_RETURN Runestone (zero value)
  // We pass the raw scriptpubkey bytes directly (it already includes the
  // OP_RETURN + OP_13 prefix and the encoded edict body).
  tx.addOutput({
    script: runestoneScriptpubkey,
    amount: 0n,
  });

  // Output 1: recipient P2TR — receives the parcel
  tx.addOutputAddress(recipientAddress, BigInt(dustLimit), btc.NETWORK);

  // Output 2: relay change
  tx.addOutputAddress(changeAddress, BigInt(changeSats), btc.NETWORK);

  // -- serialize the PSBT (unsigned)
  const psbtBytes = tx.toPSBT();
  const psbtHex = bytesToHex(psbtBytes);
  const psbtBase64 = Buffer.from(psbtBytes).toString('base64');

  return {
    psbtBase64,
    psbtHex,
    psbtBytes,
    estimatedVbytes,
    feeSats,
    changeSats,
    feeRate,
    inputAmount: utxo.value,
    inputScript: bytesToHex(inputP2tr.script),
  };
}

// =============================================================================
// PSBT VALIDATION
// =============================================================================

/**
 * Round-trip sanity check: re-parse the produced PSBT and assert the input
 * count, output count, and amounts survive. Throws on any mismatch.
 *
 * @param {Uint8Array} psbtBytes — output of buildRuneTransferPsbt().psbtBytes
 * @param {object} expectations — { inputCount, outputCount, outputAmounts? }
 * @returns {{ inputCount: number, outputCount: number, outputAmounts: bigint[], runestoneFound: boolean }}
 */
function assertPsbtRoundTrip(psbtBytes, expectations = {}) {
  if (!(psbtBytes instanceof Uint8Array) && !Buffer.isBuffer(psbtBytes)) {
    throw new Error('assertPsbtRoundTrip: psbtBytes must be Uint8Array/Buffer');
  }
  const tx = btc.Transaction.fromPSBT(psbtBytes, { allowUnknownOutputs: true });
  const inputCount = tx.inputsLength;
  const outputCount = tx.outputsLength;
  const outputAmounts = [];
  let runestoneFound = false;
  for (let i = 0; i < outputCount; i++) {
    const out = tx.getOutput(i);
    outputAmounts.push(out.amount);
    // Detect Runestone by OP_RETURN (0x6a) + OP_13 (0x5d) prefix
    if (out.script && out.script.length >= 2 && out.script[0] === 0x6a && out.script[1] === 0x5d) {
      runestoneFound = true;
    }
  }
  if (expectations.inputCount != null && inputCount !== expectations.inputCount) {
    throw new Error(`assertPsbtRoundTrip: inputCount ${inputCount} != expected ${expectations.inputCount}`);
  }
  if (expectations.outputCount != null && outputCount !== expectations.outputCount) {
    throw new Error(`assertPsbtRoundTrip: outputCount ${outputCount} != expected ${expectations.outputCount}`);
  }
  if (expectations.expectRunestone && !runestoneFound) {
    throw new Error('assertPsbtRoundTrip: expected OP_RETURN+OP_13 Runestone output but none found');
  }
  return { inputCount, outputCount, outputAmounts, runestoneFound };
}

// =============================================================================
// HELPERS
// =============================================================================

function bytesToHex(u8) {
  if (u8 instanceof Uint8Array || Buffer.isBuffer(u8)) {
    return Buffer.from(u8).toString('hex');
  }
  throw new Error('bytesToHex: expected Uint8Array/Buffer');
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // UTXO fetching (Phase 3a)
  fetchUtxosFromMempoolSpace,
  pickLargestUtxo,
  // PSBT building (Phase 3a)
  buildRuneTransferPsbt,
  assertPsbtRoundTrip,
  // Constants
  MEMPOOL_API_BASE,
  // Private helpers exposed for tests
  _bytesToHex: bytesToHex,
};
