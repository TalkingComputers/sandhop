# Keepon

Keepon teleports a live local Claude Code or Codex session into an e2b sandbox and returns a browser terminal where the same session continues running. It ships the current working tree, the selected session transcript, and the auth material needed by the cloud agent without rewriting the transcript data.

## What it does

`keepon push` finds the latest Claude Code or Codex session for a project directory, builds a tarball of the working tree, copies the transcript byte-for-byte, creates an e2b sandbox, installs the exact local agent CLI version, restores the transcript under the sandbox project path, and starts `ttyd` on port `7681`.

The default output is:

```text
KEEPON_URL https://<e2b-host>
KEEPON_AUTH keepon:<password>
```

Open the URL and authenticate with user `keepon` and the printed password.

## The wedge

Claude-on-web and Codex cloud flows are good when the source of truth is already remote. Keepon targets the gap where the useful session is local:

- Dirty-tree teleport: uncommitted, untracked, and generated local files in the working tree go with the session.
- Cross-tool continuation: the same engine supports Claude Code and Codex through a small adapter seam.
- Session continuity: Keepon resumes the real local transcript instead of starting a fresh cloud chat.

## Architecture

Keepon is a TypeScript Node engine plus thin plugin prompts.

Engine units:

- `src/cli.ts`: parses `push`, `list`, `kill`, `--agent`, `--session`, `--cwd`, and `--tailscale`; detects the CLI version; prints machine-readable output.
- `src/adapters.ts`: contains Claude Code and Codex session discovery, transcript placement, install package, and resume command facts.
- `src/auth.ts`: extracts Claude Code or Codex credentials into env vars or sandbox files.
- `src/manifest.ts`: records agent, local cwd, remote cwd, transcript filename, session id, timestamp, and local CLI version.
- `src/snapshot.ts`: tars the working tree and copies the transcript byte-for-byte.
- `src/bootstrap.ts`: renders the sandbox restore script.
- `src/sandbox.ts`: creates the e2b sandbox, uploads files, runs bootstrap, starts `ttyd`, and returns the public or private URL.

Plugin units:

- `plugin/commands/keepon.md`: Claude Code slash command instructions.
- `plugin/prompts/keepon.md`: Codex prompt instructions.

## Security model

Keepon moves session data exactly as-is. It does not truncate, compact, rewrite, or inject text into the transcript.

Auth material is not included in `bundle.tgz`. Claude Code credentials travel as sandbox environment variables. Codex can use sandbox environment variables or a copied `~/.codex/auth.json` written separately after sandbox creation. The e2b SDK connection uses TLS, so env injection and file upload travel over the SDK channel rather than inside the project tarball.

Default mode exposes `ttyd` through the e2b HTTPS host. `ttyd` is protected with per-teleport Basic Auth: user `keepon`, password `randomBytes(18).toString("base64url")`. The browser connection is HTTPS plus Basic Auth.

Optional Tailscale mode keeps `ttyd` private to your tailnet. The sandbox installs Tailscale, starts `tailscaled` in userspace networking mode, runs `tailscale up` with `TS_AUTHKEY`, binds `ttyd` to `127.0.0.1`, waits for localhost readiness, derives the MagicDNS suffix from `tailscale status --json`, and returns:

```text
KEEPON_URL http://keepon-<sandboxId>.<magicdns-suffix>:7681
KEEPON_AUTH keepon:<password>
```

Your local machine must be on the same tailnet for that URL to work.

## Known limitations

- Multi-GB working trees are bounded by local Node heap and the single upload path. A future version should use object storage and pull from inside the sandbox.
- Codex resume depends on the shipped `~/.codex/auth.json` being the credential that created the local session, or on a compatible `OPENAI_API_KEY` flow.
- Keepon tars the project directory as-is, including git-ignored and generated files. Use a clean cwd if you do not want a file copied into the sandbox.
- Tailscale mode requires a reusable or ephemeral auth key with permission to add the sandbox node to your tailnet.
- The resumed cloud agent bills through the credential injected into the sandbox, not through any local desktop subscription UI.

## Install

```bash
npm install
npm run build
```

Required environment for real teleports:

- `E2B_API_KEY`: loaded before running Keepon so the e2b SDK can create sandboxes.
- Claude Code: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, or a supported local Keychain credential.
- Codex: `OPENAI_API_KEY` or `~/.codex/auth.json`.
- Tailscale mode only: `TS_AUTHKEY`.

Use the local secret convention:

```bash
set -a && source ~/.env.d/e2b.env && set +a
```

Load any other secret file only for the command that needs it.

## Usage

Push the current project session:

```bash
node dist/cli.js push --cwd "$(pwd)"
```

Force an agent:

```bash
node dist/cli.js push --agent codex --cwd "$(pwd)"
node dist/cli.js push --agent claude-code --cwd "$(pwd)"
```

Resume a specific session:

```bash
node dist/cli.js push --session <session-id> --cwd "$(pwd)"
```

Use the private Tailscale channel:

```bash
TS_AUTHKEY=<tskey-auth-...> node dist/cli.js push --tailscale --cwd "$(pwd)"
```

List live sandboxes:

```bash
node dist/cli.js list
```

Kill a sandbox:

```bash
node dist/cli.js kill <sandbox-id>
```

## Version-match behavior

Keepon detects the local CLI version before snapshotting:

- Claude Code: `claude --version`
- Codex: `codex --version`

It extracts the leading semver and writes it into the manifest. The sandbox then installs the exact package version with `npm i -g <agent-package>@<version>`. If Keepon cannot parse the local CLI version, it exits instead of silently installing a different version. This keeps the cloud CLI matched to the transcript schema produced by the local CLI.
