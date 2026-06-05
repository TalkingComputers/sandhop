## Learned User Preferences

- Run code-quality and architecture reviews on the whole Keepon codebase, not only the current diff.
- Treat `docs/` and architecture markdown as potentially stale; verify claims against the live tree and do not treat outdated docs as source of truth.
- When reviewing Keepon, explicitly audit the transport layer and when payloads are sent (enrich vs push).
- When reviewing Keepon, evaluate whether hand-written integration code can be replaced or shortened with official SDKs (including the MCP SDK).

## Learned Workspace Facts

- Workspace folder is Keepon; the npm package and CLI are **sandhop** (dirty-tree teleport of local Claude Code/Codex sessions to cloud sandboxes).
- Fast incremental upload: `TransferService` via `sandhop enrich`; full teleport: `TeleportService` via `sandhop push`.
- Default sandbox provider is E2B; also supports Modal, Daytona, and Vercel via `sandhop setup` or provider env vars.
- MCP-related services live under `src/core/services/` (`mcp-paths`, `mcp-code`, `mcp-classify`, `secrets`).
