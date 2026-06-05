---
description: Teleport this session to a cloud sandbox and return a browser URL
---

Run the Sandhop engine to teleport THIS session to the cloud, then give the user the URL and auth.

Steps:

1. Run: `sandhop push --cwd "$(pwd)"`. The full working tree is sent, including gitignored `.env` files and `.git`, so commit/push works in the sandbox. SSH keys for this repo's git remotes ship automatically. You may append `--exclude <comma globs>` only for large regenerable paths like `node_modules`, `dist`, and caches, and `--include <abs paths>` for needed paths outside the cwd. Never exclude source, env/config, or `.git`.
2. The command prints `SANDHOP_URL <url>` and `SANDHOP_AUTH sandhop:<pass>` immediately, then starts background enrichment for profile, skills, and MCP servers. Extract both.
3. Reply immediately with exactly: "Your session is live: <url> — log in with user `sandhop`, password `<pass>`. Profile/skills/MCP are still enriching in the background; check `/tmp/sandhop-enrich.log` in the session if asked." — nothing else.

If the command exits non-zero, show the user its stderr verbatim and stop.
