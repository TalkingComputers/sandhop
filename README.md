# Sandhop

Sandhop teleports a live local Claude Code or Codex session to a cloud sandbox and lets you continue it in an auth-gated browser terminal. It sends the dirty working tree, the active transcript, and the agent auth needed to resume the same session remotely — no commit, no context re-injection, native `--resume`.

## Why Sandhop

Claude on the web and Codex cloud are good for clean repo tasks. Sandhop is for the messy local moment: uncommitted files, generated state, local slash commands, MCP config, and either Claude Code or Codex. The wedge is dirty-tree + cross-tool teleport, not another hosted agent UI.

## Quickstart

```bash
npm install -g sandhop
sandhop setup
```

`sandhop setup` is a short wizard: pick your sandbox provider, paste its API key, choose a transport, and it installs the `/sandhop` command into whichever agents you have (Claude Code and/or Codex). Credentials are stored in `~/.config/sandhop/config.json` (mode 600). You are never asked for your Claude/Codex API key — that auth is captured from your existing local session at teleport time.

Then, from inside any Claude Code or Codex session in a project:

```text
/sandhop
```

It runs `sandhop push` for the current session and prints the web-terminal URL:

```text
SANDHOP_URL  https://<host>
SANDHOP_AUTH sandhop:<password>
```

Open `SANDHOP_URL` and sign in with the `SANDHOP_AUTH` user/password to continue your session in the browser.

## Sandbox providers

Sandhop is provider-agnostic. `sandhop setup` configures the default; override per-run with `--provider`.

| Provider           | `--provider` | Credentials (collected by `sandhop setup`)            |
| ------------------ | ------------ | ----------------------------------------------------- |
| **E2B** (default)  | `e2b`        | `E2B_API_KEY`                                         |
| **Modal**          | `modal`      | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`                |
| **Daytona**        | `daytona`    | `DAYTONA_API_KEY` (+ optional `DAYTONA_TARGET`)       |
| **Vercel Sandbox** | `vercel`     | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` |

Each provider SDK is an optional dependency, loaded lazily — installing Sandhop does not pull all four. The CLI resolves credentials **environment first, then the `sandhop setup` store**, so CI/scripts can just export the env vars and skip setup.

## Usage

```bash
sandhop push                              # teleport the latest session in $(pwd)
sandhop push --provider modal             # choose a provider for this run
sandhop push --tunnel cloudflared         # private/portable URL (see below)
sandhop push --agent codex --session <id> # pin the agent and a specific session
sandhop push --no-profile                 # core only: working tree + transcript
sandhop list                              # list running sandboxes
sandhop kill <sandbox-id>                 # destroy a sandbox
```

(`sandhop` is the global bin; `node dist/cli/main.js <cmd>` is equivalent from source.)

### Flags

- `--provider e2b|modal|daytona|vercel` — sandbox provider (default: configured / `e2b`).
- `--tunnel public|cloudflared` — URL transport (default: configured / `public`).
- `--agent claude-code|codex` — force the agent (default: auto-detect from the cwd's sessions).
- `--session <id>` — resume a specific session instead of the newest for the cwd.
- `--no-profile` — skip profile/plugin/skill/MCP enrichment; the working tree + transcript still move.
- `--cwd <path>` — operate on a directory other than the process cwd.

## Transports / private access

- **`--tunnel public`** (default): exposes ttyd through the provider's HTTPS preview, gated by Sandhop's per-teleport ttyd Basic Auth.
- **`--tunnel cloudflared`**: binds ttyd to loopback and runs cloudflared inside the sandbox. Works through provider egress where native expose is token-gated (e.g. Daytona).
  - _Quick tunnel_ (default): zero-config `*.trycloudflare.com` URL + Basic Auth.
  - _Named tunnel_ (Access-gated, private): set `CLOUDFLARE_TUNNEL_TOKEN` + `CLOUDFLARE_TUNNEL_HOSTNAME` (or via `sandhop setup`); Sandhop returns `https://<your-hostname>` and Cloudflare Access enforces login.

## What transfers

- **Working tree** — full dirty/uncommitted state, restored at its original absolute path so the resumed session's recorded cwd matches.
- **Transcript** — the exact session file; resumed natively (`claude --resume` / `codex resume`), not re-injected.
- **Agent auth** — Claude/Codex credentials shipped as sandbox env/credential files over TLS, never inside the project tarball.
- **Profile** (enrichment) — settings, `CLAUDE.md`/`AGENTS.md`, commands, skills, plugins; plugins/skills are rebuilt from manifests/refs in-cloud (byte-equivalent versions) rather than bulk-uploaded.
- **MCP servers** — config + referenced env/secrets + local-path server code, with a raised startup timeout so `npx`-based servers finish installing. Servers that cannot run in a fresh sandbox (localhost/loopback DSNs, etc.) are excluded with a logged reason.

## How it works

1. **Fast core**: collect the working-tree root, transcript, auth, secrets, and local CLI version in parallel; create a single-tenant ephemeral sandbox; upload the bundle + transcript; install the matching agent CLI; restore the transcript; start ttyd; return the URL. Target: under ~2 minutes for ordinary projects.
2. **Detached enrichment**: transfer portable profile + MCP local code, then rebuild reproducible plugins/skills/deps from manifests so the URL stays fast.

## Security model

- Single-tenant ephemeral sandbox per push; auth/secrets travel as env/credential files over TLS, not in the tarball.
- Default access is HTTPS + per-teleport ttyd Basic Auth; `--tunnel cloudflared` adds quick-tunnel or Access-gated named-tunnel options.
- Sandhop never logs secret values.
- Destroy a sandbox with `sandhop kill <sandbox-id>`.

## Architecture

TypeScript modular monolith with a hexagonal core.

- `src/core`: ports, pure data types, orchestration services (teleport, enrichment, snapshot, profile, secrets, MCP).
- `src/host`: local Node filesystem/process/keychain/tar adapter.
- `src/providers`: sandbox provider adapters — E2B, Modal, Daytona, Vercel — behind one `SandboxProvider` port + registry.
- `src/agents`: Claude Code and Codex adapters behind one `Agent` port.
- `src/transports`: `public` (provider URL) and `cloudflared` URL adapters.
- `src/cli`: composition root, `sandhop setup` wizard, and CLI entrypoints.
- `plugin/`: the `/sandhop` command (`commands/`) and prompt (`prompts/`) wrappers installed by `sandhop setup`.

## Limitations

- You need an existing local Claude Code or Codex session for the target cwd.
- Large dirty trees take time to archive and upload.
- Enrichment can finish after the terminal is usable; check `/tmp/sandhop-enrich.log` inside the sandbox.
- MCP servers that depend on local-only resources (localhost databases, local data files, a browser) or that require interactive OAuth (e.g. Notion, Ramp) won't function in a fresh sandbox — log in inside the sandbox, or expect them absent/unauthenticated.
- **Codex resume is org-bound**: it replays the session's encrypted reasoning to the API, so the shipped credential must belong to the org that created the rollout. The default `~/.codex/auth.json` ships as-is (fine for ordinary OpenAI logins). Sessions created under a custom provider profile (e.g. Azure) resume only with that provider's credential; ChatGPT-OAuth `auth.json` (no `OPENAI_API_KEY`) is unverified for cross-machine resume.
- The agent CLI installs at your exact local version, so Codex may show its standard "update available" notice — informational; choose "skip" to continue.
- Cloud rebuilds need network access to the git/npm/bun/uv sources referenced by your manifests.

## Development

```bash
npm ci
npm run build
npx vitest run
```

## License

MIT © Talking Computers
