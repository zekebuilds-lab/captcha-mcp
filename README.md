# @powforge/captcha-mcp

**Your MCP server returns 429 when agents pound it. captcha-mcp makes them earn their next call instead.** Hand the agent a proof-of-work puzzle (free, ~5s of CPU) or a 3-sat Lightning invoice — both are machine-readable backoff signals an autonomous caller can satisfy without an account, email, or API key.

Three tools over stdio or HTTP. Stdlib only. No signup, free fallback, self-hosted, no revenue share.

## Why not 429?

429 Too Many Requests is the wrong shape for the agent era. Three patterns recur across MCP server reports:

- **Agent frameworks treat 429 as a connection failure.** They retry immediately, often with exponential backoff that is still too aggressive, and amplify the overload that triggered the limit in the first place.
- **There is no per-caller signal.** A 429 fires for the bucket, not the agent. One noisy caller gets every other caller throttled, and the server has no way to ask the noisy one to slow down specifically.
- **Retry-After is advisory and frequently ignored.** Agents do not consistently parse it, do not consistently respect it, and have no incentive to wait — the cost of retrying is zero.

captcha-mcp replaces the 429 with a 402-style challenge. The next call costs the caller something (CPU seconds or 3 sats). That cost is per-caller, machine-readable, and self-throttling — an agent that cannot solve the puzzle cannot flood the endpoint.

## Quickstart

```bash
npx -y @powforge/captcha-mcp
```

No install, no config, no API key. The server starts on stdio and waits for an MCP client.

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

## HTTP Streamable transport

Hosted MCP clients (Smithery, browser-based hosts) need HTTP, not stdio. Pass `--http` or set `HTTP_MODE=1`:

```bash
HTTP_MODE=1 PORT=3200 npx @powforge/captcha-mcp
# or
npx @powforge/captcha-mcp --http
```

The server then listens on:

| Endpoint     | Method | Purpose                                                                        |
|--------------|--------|--------------------------------------------------------------------------------|
| `/mcp`       | POST   | Single JSON-RPC request, single JSON-RPC response. Notifications return 202.   |
| `/mcp`       | GET    | SSE stream for server-pushed notifications (kept open with a 25s heartbeat).  |
| `/health`    | GET    | Liveness probe — returns `{ok, server, transport}`. Not part of MCP.           |

Stateless. No session ids. CORS open (`Access-Control-Allow-Origin: *`) so browser clients work. Stdio mode is unchanged and remains the default — `npx @powforge/captcha-mcp` with no flag still talks JSON-RPC over stdin/stdout.

Smoke test the HTTP transport:

```bash
HTTP_MODE=1 PORT=3200 node src/server.js &
curl -X POST http://localhost:3200/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}'
```

Returns `{jsonrpc:"2.0", id:1, result:{protocolVersion:"2024-11-05", capabilities:{tools:{}}, serverInfo:{...}}}`.

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

You should see a JSON response with `serverInfo: { name: "@powforge/captcha-mcp", version: "0.2.2" }`.

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

## How this compares to other MCP agent-auth primitives

A side-by-side breakdown against `x402-mcp`, `@agentauth/mcp`, and Cloudflare ARC/ACT is published at [powforge.dev/mcp/compare/x402-mcp](https://powforge.dev/mcp/compare/x402-mcp/). Short version: `captcha-mcp` is the only entrant that ships a free PoW tier alongside a Lightning paid skip on an MCP transport. The other three price every call (USDC) or require platform-issued credentials.

## License

MIT
