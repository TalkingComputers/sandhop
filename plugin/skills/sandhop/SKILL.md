---
name: sandhop
description: Teleport this Codex session to a cloud sandbox and return a browser URL. Use when the user asks to sandhop, teleport, hop, or move this session to the cloud, a sandbox, their phone, or another device.
---

Teleport this Codex session to a cloud sandbox so the user can keep working in the browser. The goal: pick up this exact workflow in the cloud — same files, tools, tokens, and file paths.

Work out what this session needs to keep going, and make sure each piece is either already in the cloud or gets sent:

- The project we're in — source, `.env`, config, and `.git`. All of it goes.
- Tools, tokens, and the agent login — sandhop ships detected agent auth and referenced secrets. If this work leans on something unusual (a CLI it shells out to, an API key or token in a non-standard place, a credential file), make sure it's covered with `--include`, or confirm the sandbox can rebuild it. Don't leave the workflow missing a tool or token.
- Any other file outside the project this work touches — a config under `~/.config`, a data file, wherever it lives. Look at what this session has been doing to decide.
- Leave out rebuildable artifacts — the sandbox rebuilds those. Always pass the full standard exclude list from the command below: an exclude for a dir that doesn't exist costs nothing, so never spend time checking which ones are present (they're usually gitignored, so file listings hide them anyway). Then think about which languages this project uses and add their build/cache dirs if not already covered — Rust `target`, Python `.venv` `__pycache__` `.tox`, JS/TS `node_modules` `dist` `build` `.next` `out` `.turbo`, Go `bin`, JVM `build` `.gradle` `target`, .NET `bin` `obj`, and the like.

Run it from the project directory:

```
sandhop push --agent codex --cwd "$(pwd)" --exclude node_modules,dist,build,out,.next,target,__pycache__,.venv --include <absolute paths of the outside files it needs>
```

Only ever add to the exclude list — never trim it. `--include` takes absolute paths; each file or directory is recreated at the same path in the sandbox. Never exclude source, `.env`/config, or `.git`.

It prints `SANDHOP_URL <url>` and `SANDHOP_AUTH <user>:<pass>`. Reply with: "Your session is live: <url> — user `<user>`, password `<pass>`." If it fails, show the stderr.
