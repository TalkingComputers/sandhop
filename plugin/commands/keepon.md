---
description: Teleport this session to a cloud sandbox and return a browser URL
---

Run the Keepon engine to teleport THIS session to the cloud, then give the user the URL and auth.

Steps:

1. Run: `node ${CLAUDE_PLUGIN_ROOT}/../dist/cli/main.js push --cwd "$(pwd)"`
2. The command prints `KEEPON_URL <url>` and `KEEPON_AUTH keepon:<pass>`. Extract both.
3. Reply with exactly: "Your session is live: <url> — log in with user `keepon`, password `<pass>`." — nothing else.

If the command exits non-zero, show the user its stderr verbatim and stop.
