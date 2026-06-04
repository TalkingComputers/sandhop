Teleport the current Codex session to a cloud sandbox.

Run this shell command from the current working directory:

sandhop push --agent codex --cwd "$(pwd)"

It prints `SANDHOP_URL <url>` and `SANDHOP_AUTH sandhop:<pass>` immediately, then starts background enrichment for profile, skills, and MCP servers. Report both immediately as: "Your session is live: <url> — log in with user `sandhop`, password `<pass>`. Profile/skills/MCP are still enriching in the background; check `/tmp/sandhop-enrich.log` in the session if asked." If it fails, show the stderr.
