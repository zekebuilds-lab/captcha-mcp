#!/usr/bin/env node
/**
 * End-to-end smoke test: drive the MCP server over stdio, get a challenge,
 * solve it locally, call verify, confirm we get a token back.
 *
 * Run with:
 *   node scripts/e2e-smoke.js
 *
 * Requires the pow-captcha HTTP service running at CAPTCHA_URL (default
 * http://localhost:3077).
 */

'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

function meetsLeadingZeros(hex, bits) {
  const fullNibbles = Math.floor(bits / 4);
  for (let i = 0; i < fullNibbles; i++) if (hex[i] !== '0') return false;
  const rem = bits % 4;
  if (rem > 0 && parseInt(hex[fullNibbles], 16) > (0xf >> rem)) return false;
  return true;
}

function solvePoW(salt, difficulty) {
  let n = 0;
  while (n < 100_000_000) {
    const nonce = n.toString(36);
    const hash = crypto.createHash('sha256').update(salt + nonce).digest('hex');
    if (meetsLeadingZeros(hash, difficulty)) return nonce;
    n++;
  }
  throw new Error('PoW timeout');
}

async function main() {
  const serverPath = path.join(__dirname, '..', 'src', 'server.js');
  const proc = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });

  const responses = new Map();
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (typeof msg.id !== 'undefined') {
        const cb = responses.get(msg.id);
        if (cb) cb(msg);
      }
    }
  });

  function call(id, method, params) {
    return new Promise((resolve) => {
      responses.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function notify(method, params) {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  console.log('1. initialize');
  const init = await call(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-smoke', version: '1' },
  });
  if (!init.result || !init.result.serverInfo) throw new Error('initialize failed');
  console.log('   OK  serverInfo=' + JSON.stringify(init.result.serverInfo));
  notify('notifications/initialized');

  console.log('2. tools/call status');
  const st = await call(2, 'tools/call', { name: 'status', arguments: {} });
  const stData = JSON.parse(st.result.content[0].text);
  if (!stData.ok) throw new Error('status returned not-ok: ' + JSON.stringify(stData));
  console.log('   OK  pow_solves=' + stData.stats.pow_solves);

  console.log('3. tools/call challenge');
  const ch = await call(3, 'tools/call', { name: 'challenge', arguments: {} });
  const chData = JSON.parse(ch.result.content[0].text);
  if (!chData.id || !chData.salt) throw new Error('challenge failed: ' + JSON.stringify(chData));
  console.log('   OK  id=' + chData.id.slice(0, 20) + '... difficulty=' + chData.difficulty);

  console.log('4. solve PoW locally');
  const t0 = Date.now();
  const nonce = solvePoW(chData.salt, chData.difficulty);
  console.log('   OK  nonce=' + nonce + ' solveMs=' + (Date.now() - t0));

  console.log('5. tools/call verify');
  const ve = await call(4, 'tools/call', {
    name: 'verify',
    arguments: {
      salt: chData.salt,
      nonce,
      id: chData.id,
      signature: chData.signature,
      algo: chData.algo,
      difficulty: chData.difficulty,
    },
  });
  const veData = JSON.parse(ve.result.content[0].text);
  if (!veData.valid || !veData.token) throw new Error('verify failed: ' + JSON.stringify(veData));
  console.log('   OK  token=' + veData.token.slice(0, 24) + '... method=' + veData.method);

  proc.stdin.end();
  await new Promise((r) => proc.on('exit', r));
  console.log('\nE2E smoke PASS');
}

main().catch((e) => {
  console.error('E2E smoke FAIL:', e.message);
  process.exit(1);
});
