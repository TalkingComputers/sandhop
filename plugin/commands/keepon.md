---
description: Teleport this session to a cloud sandbox and return a browser URL
---

Run the Keepon engine to teleport THIS session to the cloud, then give the user the URL and auth.

Steps:

1. Run: `node ${CLAUDE_PLUGIN_ROOT}/../dist/cli/main.js push --cwd "$(pwd)"`
2. The command prints `KEEPON_URL <url>` and `KEEPON_AUTH keepon:<pass>` immediately, then starts background enrichment for profile, skills, and MCP servers. Extract both.
3. Reply immediately with exactly: "Your session is live: <url> — log in with user `keepon`, password `<pass>`. Profile/skills/MCP are still enriching in the background; check `/tmp/keepon-enrich.log` in the session if asked." — nothing else.

If the command exits non-zero, show the user its stderr verbatim and stop.
