Teleport the current Codex session to a cloud sandbox.

Run this shell command from the current working directory:

node <KEEPON_DIST>/cli.js push --agent codex --cwd "$(pwd)"

It prints `KEEPON_URL <url>`. Report that URL to me as: "Your session is live in the cloud: <url>". If it fails, show the stderr.
