Teleport the current Codex session to a cloud sandbox.

Run this shell command from the current working directory:

node <KEEPON_DIST>/cli/main.js push --agent codex --cwd "$(pwd)"

It prints `KEEPON_URL <url>` and `KEEPON_AUTH keepon:<pass>`. Report both as: "Your session is live: <url> — log in with user `keepon`, password `<pass>`." If it fails, show the stderr.
