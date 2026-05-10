# @powforge/captcha-mcp

**Charge AI agents per-call without accounts.** PoW solve = free tier. Lightning payment = paid tier.

OpenAI's Sora API does not let you charge per call. Anthropic's billing does not pass through to your tools. If you ship an MCP server today and an autonomous agent finds it, you eat the bill.

This is the gate. Three tools over stdio. Stdlib only.

## Quickstart

```bash
npx -y @powforge/captcha-mcp
```

That is it. No install, no config, no API key. The server starts on stdio and waits for an MCP client.

To wire it into Claude Code, Cursor, or any MCP-compatible host, add to your config:

```json
{
  "mcpServers": {
    "powforge-captcha": {
      "command": "npx",
      "args": ["-y", "@powforge/captcha-mcp"]
    }
  }
}
```

Or run `npx @powforge/captcha-mcp --install` to print the config block.

## What it does

Wraps the PowForge pow-captcha service ([captcha.powforge.dev](https://captcha.powforge.dev)) as three MCP tools:

| Tool        | Purpose                                                                 |
|-------------|-------------------------------------------------------------------------|
| `challenge` | Request a fresh proof-of-work puzzle. Returns `{id, salt, difficulty, signature}`. |
| `verify`    | Submit a solved nonce. Returns a 5-minute HMAC-signed access token.     |
| `status`    | Server health, lifetime stats, L402 endpoint metadata.                  |

The free tier costs the agent ~5-10 seconds of CPU time (SHA-256, default 14 leading zero bits). The paid tier costs 3 sats over Lightning via L402 (RFC 7235 + bolt11 invoice in `WWW-Authenticate`).

## Why this and not OAuth, API keys, or Stripe

| Approach                  | Per-call cost      | Account required | Self-hosted | Agent-friendly |
|---------------------------|--------------------|------------------|-------------|----------------|
| API keys                  | $0                 | yes              | n/a         | no             |
| OAuth                     | $0                 | yes              | n/a         | no             |
| Stripe metering           | high overhead      | yes              | n/a         | no             |
| Managed MCP auth platform | 100–2000 sats      | no               | no          | yes            |
| **PoW + L402 (this)**     | seconds or 3 sats  | **no**           | **yes**     | **yes**        |

Agents do not have email addresses. They do not click confirmation links. They do not enter credit cards. PoW + Lightning is the only auth primitive that works for fully autonomous callers.

Managed MCP auth platforms work, but they charge 100–2000 sats per call on vendor infrastructure — your revenue flows through their rails. This package runs on your server, your Lightning node, your keys. You keep the sats.

## Configuration

Set `CAPTCHA_URL` to point at a different captcha backend. Default is `http://localhost:3077` so you can run the full stack locally for development. Production deployments point it at `https://captcha.powforge.dev`.

```bash
CAPTCHA_URL=https://captcha.powforge.dev npx @powforge/captcha-mcp
```

## Local development

Clone the [captcha widget repo](https://www.npmjs.com/package/@powforge/captcha) or run the public service. The MCP server only needs HTTP access to the captcha endpoints listed under `status`.

```bash
git clone https://github.com/zekebuilds-lab/captcha-mcp
cd captcha-mcp
node src/server.js
```

It prints `ready` to stderr and waits for JSON-RPC on stdin.

Smoke-test the protocol manually:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' | node src/server.js
```

You should see a JSON response with `serverInfo: { name: "@powforge/captcha-mcp", version: "0.1.0" }`.

## Token verification from your own backend

When an agent submits a token to your service, verify it without trusting the agent:

```bash
curl -X POST https://captcha.powforge.dev/api/token/verify \
  -H "Content-Type: application/json" \
  -d '{"token":"<token-from-verify-tool>"}'
```

Returns `{valid: true, method, issued_at, expires_at}` or `{valid: false, reason}`.

## Related packages

- [`@powforge/captcha`](https://www.npmjs.com/package/@powforge/captcha) — the browser widget for the same service.
- [`@powforge/mcp-l402-gate`](https://www.npmjs.com/package/@powforge/mcp-l402-gate) — Express middleware to gate any MCP server with L402 + Depth-of-Identity scoring.
- [`@powforge/mcp-identity`](https://www.npmjs.com/package/@powforge/mcp-identity) — agent reputation oracle. Pair with this gate for first-call abuse protection.

## License

MIT
