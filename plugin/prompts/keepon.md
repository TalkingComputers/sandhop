Teleport the current Codex session to a cloud sandbox.

Run this shell command from the current working directory:

node <KEEPON_DIST>/cli/main.js push --agent codex --cwd "$(pwd)"

It prints `KEEPON_URL <url>` and `KEEPON_AUTH keepon:<pass>` immediately, then starts background enrichment for profile, skills, and MCP servers. Report both immediately as: "Your session is live: <url> — log in with user `keepon`, password `<pass>`. Profile/skills/MCP are still enriching in the background; check `/tmp/keepon-enrich.log` in the session if asked." If it fails, show the stderr.
