# Keepon

Keepon teleports a live local Claude Code or Codex session into an e2b sandbox and returns a browser terminal where the same session continues running. It ships the current working tree byte-for-byte, restores the selected transcript, installs the exact local CLI version, and starts the real agent TUI behind `ttyd`.

## Output

```text
KEEPON_URL https://<host>
KEEPON_AUTH keepon:<password>
```

Default access is HTTPS plus per-teleport `ttyd` Basic Auth. `--tailscale` switches to a private tailnet URL and binds `ttyd` to loopback in the sandbox.

## Architecture

The code follows `docs/ARCHITECTURE.md`:

- `src/core/ports`: `SandboxProvider`/`Sandbox`/`Capability`, `Agent`, and `HostDeps` ports.
- `src/core/services`: `SnapshotService`, `SessionService`, `ProfileService`, `SecretsService`, `AuthService`, `VersionService`, `BootstrapService`, and `TeleportService`.
- `src/agents`: declarative Claude Code and Codex agent records.
- `src/providers/e2b`: e2b SDK adapter.
- `src/host/node.ts`: Node filesystem, process, keychain, exec, and tar adapter.
- `src/cli`: args plus the single composition root.

`src/core` imports only `src/core` modules. Vendor SDKs and Node filesystem/process APIs stay at the edges.

## Data model

- `SnapshotService` tars the cwd with entries `['.']`; no language inspection and no excludes.
- `SessionService` finds the real Claude Code or Codex transcript for the cwd and preserves the original transcript filename.
- `ProfileService` ships portable agent config only: settings, instructions, commands/prompts, rules/agents/output styles, and MCP definitions. It does not ship plugins, caches, sessions, auth files, or secret directories.
- `SecretsService` scans MCP config files, extracts referenced env var names, and captures only those values from `process.env`.
- `AuthService` ships agent auth as env tokens or portable credential files.
- `TeleportService` runs collection services with `Promise.all`, creates the sandbox, uploads bundle/profile/transcript/auth, runs bootstrap, starts native resume, and returns URL/auth.

## Usage

```bash
npm install
npm run build
node dist/cli/main.js push --cwd "$(pwd)"
```

Force an agent:

```bash
node dist/cli/main.js push --agent codex --cwd "$(pwd)"
node dist/cli/main.js push --agent claude-code --cwd "$(pwd)"
```

Resume a specific session:

```bash
node dist/cli/main.js push --session <session-id> --cwd "$(pwd)"
```

Disable profile shipping:

```bash
node dist/cli/main.js push --no-profile --cwd "$(pwd)"
```

Use Tailscale:

```bash
TS_AUTHKEY=<tskey-auth-...> node dist/cli/main.js push --tailscale --cwd "$(pwd)"
```

List and kill sandboxes:

```bash
node dist/cli/main.js list
node dist/cli/main.js kill <sandbox-id>
```

Required environment for real teleports:

- `E2B_API_KEY`
- Claude Code: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, or a supported local Keychain credential
- Codex: `OPENAI_API_KEY` or `~/.codex/auth.json`
- Tailscale mode only: `TS_AUTHKEY`
