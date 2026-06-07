Teleport this Codex session to a cloud sandbox so the user can keep working in the browser. The goal: pick up this exact workflow in the cloud — same files, tools, tokens, and file paths.

Work out what this session needs to keep going, and make sure each piece is either already in the cloud or gets sent:

- The project we're in — source, `.env`, config, and `.git`. All of it goes.
- Tools, tokens, and the agent login — sandhop ships detected agent auth and referenced secrets. If this work leans on something unusual (a CLI it shells out to, an API key or token in a non-standard place, a credential file), make sure it's covered with `--include`, or confirm the sandbox can rebuild it. Don't leave the workflow missing a tool or token.
- Any other file outside the project this work touches — a config under `~/.config`, a data file, wherever it lives. Look at what this session has been doing to decide.
- Leave out big rebuildable stuff: `node_modules`, `dist`, `build`, `out`, `.next`, `target`, `__pycache__`, `.venv`, caches, logs — the sandbox rebuilds those.

Run it from the project directory:

```
sandhop push --agent codex --cwd "$(pwd)" --exclude node_modules,dist,build,out,.next,target,__pycache__,.venv --include <absolute paths of the outside files it needs>
```

Drop excludes the project doesn't have; add other rebuildable dirs it does. `--include` takes absolute paths; each file is recreated at the same path in the sandbox. Never exclude source, `.env`/config, or `.git`.

It prints `SANDHOP_URL <url>` and `SANDHOP_AUTH <user>:<pass>`. Reply with: "Your session is live: <url> — user `<user>`, password `<pass>`." If it fails, show the stderr.
