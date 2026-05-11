#!/usr/bin/env node
/**
 * @powforge/captcha-mcp — Rune PoW Fair-Launch Phase 3b: Etch Broadcaster
 *
 * Tick 550, build/141 phase 3b. Reads the minting key and commitment UTXO
 * state, builds the etching transaction, signs it via Taproot script-path
 * spend (revealing the rune name commitment per the ord commit-reveal spec),
 * and broadcasts to Bitcoin mainnet.
 *
 * Prerequisites before running:
 *   1. scripts/generate-rune-minting-key.js must have been run (key exists).
 *   2. The commitment P2TR address must be funded (>=25,000 sats via Boltz).
 *   3. The funding UTXO must have >= 6 block confirmations.
 *   4. data/rune-mint-state.json must exist with { commitment_address, utxo }.
 *
 * Etch tx layout (per design doc rune-pow-fairlaunch-design.md):
 *   Input 0: commitment UTXO (script-path spend — reveals commitment bytes)
 *   Output 0: relay P2TR (receives premine + funding minus fee)
 *   Output 1: OP_RETURN Runestone (etching spec)
 *
 * The etching Runestone carries:
 *   rune:        POWFORGEPROOF (displayed as POWFORGE•PROOF)
 *   symbol:      ⚒
 *   divisibility: 0
 *   premine:     21,000,000 raw units (= 21,000 × 1,000-unit parcels)
 *   terms:       null (disables open mint — distribution via relay only)
 *   spacers:     [8] (positions • between POWFORGE and PROOF)
 *
 * After successful broadcast, the etch txid is written to data/rune-mint-state.json
 * and POWFORGE_RUNE_ID can be computed from the txid + confirmation block height.
 *
 * Usage:
 *   node packages/captcha-mcp/src/rune-etch.js
 *   node packages/captcha-mcp/src/rune-etch.js --dry-run   (skip broadcast)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const btc = require('@scure/btc-signer');
const { schnorr, Point } = require('@noble/secp256k1');
const { encodeRunestone } = require('@magiceden-oss/runestone-lib');
const { bech32m } = require('@scure/base');

// =============================================================================
// CONFIG
// =============================================================================

const KEY_PATH = path.join(process.env.HOME, '.config/powforge/rune-minting-key.hex');
const STATE_PATH = path.join(__dirname, '../../../data/rune-mint-state.json');

// POWFORGEPROOF rune name commitment bytes (matches generate-rune-minting-key.js)
const RUNE_COMMITMENT = Buffer.from('d777618111c4ff15', 'hex');

const RUNE_CONFIG = {
  runeName: 'POWFORGEPROOF',
  divisibility: 0,
  premine: 21_000_000n,
  symbol: '⚒',
  spacers: [8],
};

const FEE_RATE = 2; // sat/vbyte — low priority, confirms within ~24h
const DUST_LIMIT = 546; // minimum output value for P2TR

const BITCOIN_RPC = {
  host: 'lightning.lan',
  port: 8332,
  user: 'zeke',
  pass: 'lOb_sXqOc4oT5UScfDajB2fepQQhvxyf8s9LOQ8mydA',
};

const MEMPOOL_API = 'https://mempool.space/api';

const MIN_CONFIRMATIONS = 6;
const DRY_RUN = process.argv.includes('--dry-run');

// =============================================================================
// BIP-341 UTILITIES (mirror of generate-rune-minting-key.js — kept local)
// =============================================================================

function taggedHash(tag, ...data) {
  const tagHash = crypto.createHash('sha256').update(tag).digest();
  const h = crypto.createHash('sha256');
  h.update(tagHash);
  h.update(tagHash);
  for (const d of data) h.update(d);
  return h.digest();
}

function buildCommitmentScript(xonlyPubkeyBuf) {
  return Buffer.concat([
    Buffer.from([RUNE_COMMITMENT.length]),
    RUNE_COMMITMENT,
    Buffer.from([0x75]),              // OP_DROP
    Buffer.from([xonlyPubkeyBuf.length]),
    Buffer.from(xonlyPubkeyBuf),
    Buffer.from([0xac]),              // OP_CHECKSIG
  ]);
}

// =============================================================================
// BITCOIN RPC
// =============================================================================

function rpcCall(method, params = []) {
  const body = JSON.stringify({ jsonrpc: '1.0', id: 1, method, params });
  const auth = Buffer.from(`${BITCOIN_RPC.user}:${BITCOIN_RPC.pass}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: BITCOIN_RPC.host,
      port: BITCOIN_RPC.port,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Basic ${auth}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(`RPC ${method}: ${parsed.error.message}`));
          resolve(parsed.result);
        } catch (e) {
          reject(new Error(`RPC parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// =============================================================================
// MEMPOOL.SPACE UTXO FETCH (fallback UTXO lookup)
// =============================================================================

async function fetchUtxo(address) {
  const url = `${MEMPOOL_API}/address/${address}/utxo`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mempool.space UTXO fetch failed: ${res.status}`);
  const utxos = await res.json();
  const confirmed = utxos.filter((u) => u && u.status && u.status.confirmed === true);
  if (confirmed.length === 0) return null;
  return confirmed.reduce((best, u) => (!best || u.value > best.value ? u : best), null);
}

async function fetchBlockHeight() {
  const res = await fetch(`${MEMPOOL_API}/blocks/tip/height`);
  if (!res.ok) throw new Error(`mempool.space height fetch failed: ${res.status}`);
  return parseInt(await res.text(), 10);
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  // 1. Load minting key
  if (!fs.existsSync(KEY_PATH)) {
    throw new Error(`Minting key not found at ${KEY_PATH}. Run: node scripts/generate-rune-minting-key.js`);
  }
  const privHex = fs.readFileSync(KEY_PATH, 'utf8').trim();
  const secretKey = Buffer.from(privHex, 'hex');
  const xonlyPubkey = Buffer.from(schnorr.getPublicKey(secretKey));

  // 2. Rebuild commitment P2TR (must match generate-rune-minting-key.js)
  const commitScript = buildCommitmentScript(xonlyPubkey);
  const p2trCommit = btc.p2tr(xonlyPubkey, { script: commitScript }, btc.NETWORK, true);
  console.log(`Commitment address: ${p2trCommit.address}`);

  // 3. Load state (contains funding UTXO info if already funded)
  let state = {};
  if (fs.existsSync(STATE_PATH)) {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  }

  // 4. Fetch the funding UTXO (largest confirmed UTXO at commitment address)
  console.log('Fetching UTXOs from mempool.space...');
  const utxo = await fetchUtxo(p2trCommit.address);
  if (!utxo) {
    throw new Error(
      `No confirmed UTXOs found at ${p2trCommit.address}.\n` +
      `Fund this address with >= 25,000 sats via Boltz reverse swap:\n` +
      `  POST https://api.boltz.exchange/v2/swap/reverse\n` +
      `  { "to": "BTC", "from": "BTC", "invoiceAmount": 25000,\n` +
      `    "claimPublicKey": "${xonlyPubkey.toString('hex')}", "preimageHash": "<random 32 bytes hex>" }\n` +
      `LNBits balance required: >= 25,000 sats (current deficit: check LNBits).`
    );
  }
  console.log(`UTXO: ${utxo.txid}:${utxo.vout} = ${utxo.value} sats (block ${utxo.status.block_height})`);

  // 5. Check confirmations
  const tipHeight = await fetchBlockHeight();
  const utxoHeight = utxo.status.block_height;
  const confirmations = tipHeight - utxoHeight + 1;
  console.log(`Confirmations: ${confirmations}/${MIN_CONFIRMATIONS} (tip=${tipHeight}, utxo=${utxoHeight})`);
  if (confirmations < MIN_CONFIRMATIONS) {
    throw new Error(
      `UTXO has only ${confirmations} confirmations. Need >= ${MIN_CONFIRMATIONS} for ord commit-reveal.\n` +
      `Blocks remaining: ${MIN_CONFIRMATIONS - confirmations}. Try again in ~${(MIN_CONFIRMATIONS - confirmations) * 10} minutes.`
    );
  }

  // 6. Encode the etching Runestone
  const { encodedRunestone } = encodeRunestone({ etching: RUNE_CONFIG });
  console.log(`Runestone: ${encodedRunestone.length} bytes (hex: ${encodedRunestone.toString('hex')})`);

  // 7. Estimate fee: P2TR script-path input ≈ 107 vbytes (witness heavy),
  //    OP_RETURN output ≈ 10 + payload, P2TR output ≈ 43, overhead ≈ 10.5
  const estimatedVbytes = Math.ceil(10 + 107 + (10 + encodedRunestone.length) + 43);
  const feeSats = Math.ceil(estimatedVbytes * FEE_RATE);
  const relaySats = utxo.value - feeSats;
  if (relaySats < DUST_LIMIT) {
    throw new Error(`Insufficient funds: ${utxo.value} sats - ${feeSats} fee = ${relaySats} < ${DUST_LIMIT} dust`);
  }
  console.log(`Fee: ${feeSats} sats (${estimatedVbytes} vbytes × ${FEE_RATE} sat/vB), relay gets: ${relaySats} sats`);

  // 8. Build etch tx
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({
    txid: utxo.txid,
    index: utxo.vout,
    witnessUtxo: {
      script: p2trCommit.script,
      amount: BigInt(utxo.value),
    },
    tapInternalKey: xonlyPubkey,
    tapLeafScript: p2trCommit.tapLeafScript,
  });

  // Output 0: relay P2TR — receives premine and BTC (key-path only, no script)
  const relayP2tr = btc.p2tr(xonlyPubkey, undefined, btc.NETWORK);
  tx.addOutputAddress(relayP2tr.address, BigInt(relaySats), btc.NETWORK);

  // Output 1: OP_RETURN Runestone
  tx.addOutput({ script: encodedRunestone, amount: 0n });

  // 9. Sign + finalize
  tx.sign(secretKey);
  tx.finalize();

  const txHex = Buffer.from(tx.toBytes()).toString('hex');
  const actualVsize = tx.vsize;
  const actualFee = utxo.value - relaySats;
  console.log(`Actual vsize: ${actualVsize} vbytes, fee: ${actualFee} sats, relay: ${relaySats} sats`);
  console.log(`Tx hex (first 80): ${txHex.slice(0, 80)}...`);

  if (DRY_RUN) {
    console.log('DRY RUN — skipping broadcast');
    console.log(`Full tx hex:\n${txHex}`);
    return;
  }

  // 10. Broadcast via lightning.lan:8332 sendrawtransaction (primary)
  let txid;
  try {
    txid = await rpcCall('sendrawtransaction', [txHex]);
    console.log(`Broadcast SUCCESS via lightning.lan: txid = ${txid}`);
  } catch (rpcErr) {
    console.warn(`lightning.lan broadcast failed: ${rpcErr.message}`);
    console.warn('Falling back to mempool.space broadcast...');
    const res = await fetch(`${MEMPOOL_API}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: txHex,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`mempool.space broadcast failed (${res.status}): ${body}`);
    }
    txid = (await res.text()).trim();
    console.log(`Broadcast SUCCESS via mempool.space: txid = ${txid}`);
  }

  // 11. Persist etch state
  const etchState = {
    ...state,
    status: 'etched',
    etch_txid: txid,
    relay_address: relayP2tr.address,
    relay_sats: relaySats,
    etch_timestamp: new Date().toISOString(),
    note: 'After confirmation, get RUNE_ID from ord: block:tx of the etch tx. Set POWFORGE_RUNE_ID=<block>:<tx> in systemd unit.',
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(etchState, null, 2));
  console.log(`State written to ${STATE_PATH}`);
  console.log(`\n✅ POWFORGE•PROOF etched! txid: ${txid}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Wait for tx to confirm and check ordinals.com/rune/POWFORGE%E2%80%A2PROOF`);
  console.log(`  2. Get the confirmed block height of this tx`);
  console.log(`  3. Set POWFORGE_RUNE_ID=<block>:<tx_index> in ops/systemd/captcha-mcp.service`);
  console.log(`  4. Redeploy captcha-mcp to enable live claim broadcasts`);
}

main().catch((err) => {
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
