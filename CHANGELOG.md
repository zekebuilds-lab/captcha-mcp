# Changelog

## 0.2.5 — 2026-08-09

Version metadata reconciliation — no behavior change.

- Fixed version drift across the package. The live 0.2.4 npm release reported `serverInfo.version: "0.2.0"` from `src/server.js`, while `server.json` was pinned at `0.2.2` and the README smoke-test told readers to expect `0.2.4`. A user following the local-dev smoke test saw a version string that matched neither the README nor npm.
- `src/server.js` `SERVER_INFO.version` 0.2.0 → 0.2.5.
- `server.json` version (both root and packages entry) 0.2.2 → 0.2.5.
- README local-dev smoke-test expected `serverInfo.version` 0.2.4 → 0.2.5.
- All four version surfaces (package.json, server.js, server.json, README) now agree.

## 0.2.3 — 2026-06-01

MCP 2025 spec compliance — outputSchema + server.json corrections.

- Added `outputSchema` to all three tools (challenge, verify, status) per MCP 2025 spec. Directories and hosts that validate schema completeness (Glama, MCPpedia) will now score higher.
- `server.js` tools/list response now includes `outputSchema` when defined.
- Bumped `server.json` version 0.1.1 → 0.2.2 (was stale by two minor versions).
- Added `remotes` entry to `server.json` pointing at the live HTTP Streamable endpoint (`captcha.powforge.dev/mcp`).
- Fixed README smoke-test version reference (0.1.0 → 0.2.2).

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
