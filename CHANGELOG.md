# Changelog

## 0.1.1 — 2026-05-10

Discoverability — npm metadata only, no behavior change.

- Added `mcpName: "io.github.zekebuilds-lab/captcha-mcp"` so the package is eligible for publication to the official MCP Registry (`registry.modelcontextprotocol.io`). The Registry validates ownership by matching this field against GitHub OAuth identity.
- Expanded npm keywords from 10 → 15. Added `mcp-server` (matches GitHub topic), `modelcontextprotocol` (no-hyphen form used by the official SDK and Context7), `claude`, `ai`, `agent`. Top-downloaded MCP packages converge on these conventions.
- See `research/mcp-discovery-channels-2026-05-10.md` in the parent repo for the full discoverability audit.

## 0.1.0 — 2026-05-09

Initial release.

- `challenge` tool: request a fresh PoW challenge from the PowForge captcha service.
- `verify` tool: verify a PoW solution and receive a 5-minute HMAC-signed token.
- `status` tool: server health, lifetime stats, L402 endpoint metadata.
- Stdio JSON-RPC 2.0 transport, stdlib only (no MCP SDK dependency).
- `CAPTCHA_URL` env var for backend override (defaults to localhost:3077).
- `--install` flag prints a ready-to-paste MCP config block.
