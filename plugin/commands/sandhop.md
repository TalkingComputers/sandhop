---
description: Teleport this session to a cloud sandbox and return a browser URL
---

Teleport this session to a cloud sandbox so the user can keep working in the browser. Think of it as copying the part of the user's laptop this session needs into the cloud, keeping the exact same file paths.

First, work out what to send:

- The project we're in — its source, `.env`, config, and `.git`. All of it goes.
- Any file outside the project that this work actually needs — a config under `~/.config`, a data file, a credential it reads — wherever it lives. Look at what this session has been doing to decide.
- Leave out big stuff the sandbox can just rebuild: `node_modules`, `dist`, `build`, `out`, `.next`, `target`, `__pycache__`, `.venv`, caches, logs.

Then run it from the project directory:

`sandhop push --cwd "$(pwd)" --exclude node_modules,dist,build,out,.next,target,__pycache__,.venv --include <absolute paths of the outside files it needs>`

- Drop any excludes the project doesn't have; add other rebuildable dirs it does.
- `--include` takes absolute paths; each file is recreated at the same path inside the sandbox.
- Never exclude source, `.env`/config, or `.git`.

It prints `SANDHOP_URL <url>` and `SANDHOP_AUTH sandhop:<pass>`. Reply with exactly: "Your session is live: <url> — user `sandhop`, password `<pass>`." If it exits non-zero, show the user its stderr and stop.
