---
description: Teleport this session to a cloud sandbox and return a browser URL
---

Run the Keepon engine to teleport THIS session to the cloud, then give the user the URL.

Steps:

1. Run: `node ${CLAUDE_PLUGIN_ROOT}/../dist/cli.js push --cwd "$(pwd)"`
2. The command prints a line `KEEPON_URL <url>`. Extract that URL.
3. Reply with exactly: "Your session is live in the cloud: <url>" — nothing else.

If the command exits non-zero, show the user its stderr verbatim and stop.
