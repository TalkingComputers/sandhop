# Keepon

Keepon teleports a live local Claude Code or Codex session to a cloud sandbox and lets you continue it in an auth-gated browser terminal. It sends the dirty working tree, the active transcript, and the agent auth needed to resume the same session remotely.

## Why Keepon

Claude on the web and Codex cloud are good for clean repo tasks. Keepon is for the messy local moment: uncommitted files, generated state, local slash commands, MCP config, and either Claude Code or Codex. The wedge is dirty-tree + cross-tool teleport, not another hosted agent UI.

## Quickstart

```bash
npm install -g keepon
```

From source:

```bash
git clone https://github.com/TalkingComputers/keepon.git
cd keepon
npm ci
npm run build
```

Set sandbox and agent auth:

```bash
export E2B_API_KEY=...
export ANTHROPIC_API_KEY=...        # Claude Code, or CLAUDE_CODE_OAUTH_TOKEN
export OPENAI_API_KEY=...           # Codex, or CODEX_API_KEY / ~/.codex/auth.json
```

Run from a live local agent session:

```bash
/keepon
```

Or run the engine directly:

```bash
node dist/cli/main.js push --cwd "$(pwd)"
```

Output:

```text
KEEPON_URL https://<sandbox-host>
KEEPON_AUTH keepon:<password>
KEEPON_ENRICHING <sandbox-id>
```

Open `KEEPON_URL` and sign in with the `KEEPON_AUTH` user/password.

## Flags

```bash
node dist/cli/main.js push --tailscale --cwd "$(pwd)"
node dist/cli/main.js push --no-profile --cwd "$(pwd)"
```

- `--tailscale`: exposes ttyd on a private tailnet URL instead of the public HTTPS port. Requires `TS_AUTHKEY`.
- `--no-profile`: skips profile, plugin, skill, and MCP enrichment. The core working tree + transcript still move.

## How it works

Keepon has a fast core path and a detached enrichment path.

1. Core collects the current working tree root, transcript, auth, secrets, and local CLI version in parallel.
2. Core creates a single-tenant ephemeral sandbox, uploads the project bundle and transcript, installs the matching Claude Code or Codex CLI, restores the transcript, starts ttyd, and returns the URL. Target: under 2 minutes for ordinary projects.
3. A detached in-cloud enrichment transfers portable profile and MCP local-code state, then rebuilds reproducible plugins, skills, and dependencies from manifests and refs. Reproducible bulk is rebuilt instead of blindly uploaded, preserving byte-equivalent versions while keeping the URL fast.

## Security model

- Agent auth and captured MCP secrets travel as sandbox env/credential files over TLS, not inside the project tarball.
- Default access is HTTPS plus per-teleport ttyd Basic Auth.
- `--tailscale` binds ttyd to loopback in the sandbox and returns a private tailnet URL.
- Each push creates a single-tenant ephemeral sandbox. Kill it with `node dist/cli/main.js kill <sandbox-id>`.
- Keepon does not log secret values.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Keepon is a TypeScript modular monolith with a hexagonal core, service layer, provider adapters, and agent adapters:

- `src/core`: ports, pure data types, and orchestration services.
- `src/host`: local Node filesystem/process/keychain/tar adapter.
- `src/providers`: sandbox provider adapters, currently E2B.
- `src/agents`: Claude Code and Codex adapters.
- `src/cli`: composition root and direct CLI entrypoints.
- `plugin/`: `/keepon` command/prompt wrappers.

Design notes live in [`docs/design/`](docs/design/): [production fixes](docs/design/production-fixes.md), [profile sync](docs/design/profile-sync.md), [fast core](docs/design/fast-core.md), [transfer](docs/design/transfer.md), [fast reinstall](docs/design/fast-reinstall.md), and [review fixes](docs/design/review-fixes.md).

## Limitations

- You need an existing local Claude Code or Codex session for the target cwd.
- Large dirty trees still take time to archive and upload.
- Detached enrichment can finish after the terminal is already usable; check `/tmp/keepon-enrich.log` inside the sandbox.
- Local-only services, databases, localhost URLs, and private files outside captured config are not reachable unless you provision them or tunnel them.
- Codex resume replays the session's encrypted reasoning to the API, which is org-bound: the shipped credential must belong to the same org that created the rollout. The default `~/.codex/auth.json` is shipped as-is, so this holds for ordinary OpenAI logins. Sessions created under a custom provider profile (e.g. an Azure profile) resume only if that provider's credential is the active one; ChatGPT-OAuth `auth.json` (no `OPENAI_API_KEY`) is unverified for cross-machine resume.
- The working tree is restored at its original absolute path inside the sandbox so the resumed session's recorded cwd matches (no directory picker) and absolute path references stay valid.
- The agent CLI is installed at the exact local version, so Codex may show its standard "update available" notice if your local version is behind the latest (sometimes a one-keypress prompt, sometimes a banner). It carries no data loss; choose "skip" to continue in the resumed session.
- Cloud rebuilds need network access to git/npm/bun/uv sources referenced by your manifests.

## Development

```bash
npm ci
npm run build
npx vitest run
```

## License

MIT © Talking Computers
