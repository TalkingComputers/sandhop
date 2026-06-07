import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BootstrapService } from "../../../src/core/services/bootstrap.js";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { CODEX } from "../../../src/agents/codex.js";
import { buildManifest } from "../../../src/core/manifest.js";
import type { Agent } from "../../../src/core/ports/agent.js";
import { EnrichmentStepId } from "../../../src/core/ports/progress.js";
import type { CodePlan } from "../../../src/core/services/mcp-code.js";
import { FakeSandbox } from "../../fakes/provider.js";

const tmuxMultiplexer = {
  id: "tmux",
  install: (): string[] => [
    "$SUDO bash -lc 'DEBIAN_FRONTEND=noninteractive apt-get install -y tmux'",
    `printf '%s\\n' 'set -g status off' 'set -g window-size latest' > "$HOME/.tmux.conf"`,
  ],
  attach: (session: string, command: string): string =>
    `tmux new -A -s ${session} ${command}`,
};

const createBootstrap = (agent: Agent): BootstrapService =>
  new BootstrapService(agent, tmuxMultiplexer);

const manifest = buildManifest({
  agent: "claude-code",
  cliVersion: "2.1.160",
  cwd: "/private/tmp/sandhop-codex2",
  sessionId: "session-id",
  transcriptName: "session-id.jsonl",
  ts: 1,
});
const ZSTD_INSTALL =
  "command -v zstd || $SUDO sh -lc 'command -v apt-get >/dev/null && (apt-get update && apt-get install -y zstd) || (command -v dnf >/dev/null && dnf install -y zstd) || (command -v apk >/dev/null && apk add zstd) || (command -v yum >/dev/null && yum install -y zstd)'";
const OWNER_SETUP =
  'SANDHOP_OWNER="$(id -u):$(id -g)"; if [ "${SANDHOP_RUNTIME_USER:-}" != "" ]; then SANDHOP_OWNER="$(id -u "$SANDHOP_RUNTIME_USER"):$(id -g "$SANDHOP_RUNTIME_USER")"; fi';
test("BootstrapService project prep sudo-creates and owns remote project before transfer", () => {
  const bootstrap = createBootstrap(CLAUDE_CODE);
  const script = bootstrap.renderPathPrep(manifest.remoteProj);

  expect(script.split("\n")).toEqual([
    "set -e",
    'SUDO=""; if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi',
    OWNER_SETUP,
    "$SUDO mkdir -p '/private/tmp/sandhop-codex2'",
    "$SUDO chown -R \"$SANDHOP_OWNER\" '/private/tmp/sandhop-codex2'",
  ]);
  expect(bootstrap.renderProjectPrep(manifest)).toBe(script);
});

test("BootstrapService prepAndUpload owns uploaded files after provider writes", async () => {
  const bootstrap = createBootstrap(CLAUDE_CODE);
  const sandbox = new FakeSandbox("sbx", "/Users/local");

  await bootstrap.prepAndUpload(
    sandbox,
    "/Users/local/.claude/.credentials.json",
    "{}",
  );

  expect(sandbox.uploads).toEqual([
    { path: "/Users/local/.claude/.credentials.json", data: "{}" },
  ]);
  expect(sandbox.execs).toEqual([
    expect.stringContaining("$SUDO mkdir -p '/Users/local/.claude'"),
    expect.stringContaining(
      `$SUDO chown "$SANDHOP_OWNER" '/Users/local/.claude/.credentials.json'`,
    ),
  ]);
});

test("BootstrapService core installs exact CLI version, places transcript, and installs tmux after ttyd before project prep and zstd", () => {
  const script = createBootstrap(CLAUDE_CODE).render(manifest, {
    home: "/home/user",
  });

  expect(script).toContain(
    'npm i -g @anthropic-ai/claude-code@2.1.160 || $SUDO env PATH="$PATH" npm i -g @anthropic-ai/claude-code@2.1.160',
  );
  expect(script).not.toContain("zstd");
  expect(script).toContain(
    'SUDO=""; if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi',
  );
  expect(script).toContain(
    'ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) TTYD_ARCH=aarch64; CF_ARCH=arm64;; *) TTYD_ARCH=x86_64; CF_ARCH=amd64;; esac',
  );
  expect(script).toContain(
    "curl -fsSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${TTYD_ARCH} -o /usr/local/bin/ttyd",
  );
  expect(script.split("\n").slice(3, 6)).toEqual([
    "command -v ttyd || { $SUDO curl -fsSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${TTYD_ARCH} -o /usr/local/bin/ttyd && $SUDO chmod +x /usr/local/bin/ttyd; }",
    "$SUDO bash -lc 'DEBIAN_FRONTEND=noninteractive apt-get install -y tmux'",
    `printf '%s\\n' 'set -g status off' 'set -g window-size latest' > "$HOME/.tmux.conf"`,
  ]);
  expect(script).toContain(
    "git config --global --add safe.directory '/private/tmp/sandhop-codex2'",
  );
  expect(script).not.toContain("$SUDO mkdir -p '/private/tmp/sandhop-codex2'");
  expect(
    script.indexOf(
      "git config --global --add safe.directory '/private/tmp/sandhop-codex2'",
    ),
  ).toBeLessThan(script.indexOf('cp /tmp/transcript.jsonl "$dest"'));
  expect(script).not.toContain(
    "$SUDO chown -R \"$SANDHOP_OWNER\" '/private/tmp/sandhop-codex2'",
  );
  expect(script).not.toContain("tar -xzf /tmp/bundle.tgz");
  expect(script).toContain('cp /tmp/transcript.jsonl "$dest"');
  expect(script).toContain("SANDHOP_RESTORE_OK");
  expect(script).not.toContain("profile.tgz");
  expect(script).not.toContain("for f in");
});

test("BootstrapService quotes remote project shell paths with metacharacters", () => {
  const spacedManifest = buildManifest({
    agent: "claude-code",
    cliVersion: "2.1.160",
    cwd: "/Users/alice/My Project;$(touch pwn)'",
    sessionId: "session-id",
    transcriptName: "session-id.jsonl",
    ts: 1,
  });
  const bootstrap = createBootstrap(CLAUDE_CODE);
  const prep = bootstrap.renderProjectPrep(spacedManifest);
  const script = bootstrap.render(spacedManifest, {
    home: "/home/user",
  });
  const quotedRemoteProj = "'/Users/alice/My Project;$(touch pwn)'\\'''";

  expect(prep).toContain(`$SUDO mkdir -p ${quotedRemoteProj}`);
  expect(prep).toContain(`$SUDO chown -R "$SANDHOP_OWNER" ${quotedRemoteProj}`);
  expect(script).toContain(
    `git config --global --add safe.directory ${quotedRemoteProj}`,
  );
  expect(script).toContain(
    "dest='/home/user/.claude/projects/-Users-alice-My-Project---touch-pwn--/session-id.jsonl'",
  );
  expect(script).not.toContain("tar -xzf /tmp/bundle.tgz");
});

test("BootstrapService emits quoted git identity after safe directory when supplied", () => {
  const script = createBootstrap(CLAUDE_CODE).render(manifest, {
    home: "/home/user",
    gitUserName: "Alice O'Connor",
    gitUserEmail: "alice+test@example.com",
  });

  const safe =
    "git config --global --add safe.directory '/private/tmp/sandhop-codex2'";
  const name = "git config --global user.name 'Alice O'\\''Connor'";
  const email = "git config --global user.email 'alice+test@example.com'";

  expect(script).toContain(safe);
  expect(script).toContain(name);
  expect(script).toContain(email);
  expect(script.indexOf(safe)).toBeLessThan(script.indexOf(name));
  expect(script.indexOf(name)).toBeLessThan(script.indexOf(email));
  expect(script.indexOf(email)).toBeLessThan(
    script.indexOf("dest='/home/user/.claude/projects"),
  );
});

test("BootstrapService injects transport steps before agent install", () => {
  const script = createBootstrap(CLAUDE_CODE).render(manifest, {
    home: "/home/user",
    transportSteps: ["install cloudflared"],
  });

  expect(script).toContain("install cloudflared");
  expect(script.indexOf("install cloudflared")).toBeLessThan(
    script.indexOf("npm i -g @anthropic-ai/claude-code@2.1.160"),
  );
});

test("BootstrapService enrichment installs runtimes and deps, writes rewritten MCP config, and marks completion", () => {
  const codePlan: CodePlan = {
    mappings: [{ localPath: "/home/local/mcp", sandboxPath: "/home/user/mcp" }],
    rewrites: [
      {
        name: "local",
        transport: "stdio",
        command: "node",
        args: ["/home/user/mcp/server.js"],
        cwd: "/home/user/mcp",
      },
    ],
    runtimes: new Set(["bun", "uv"]),
    installCmds: ["cd '/home/user/mcp' && npm ci"],
    referencedFiles: [],
    envRefs: [],
    excluded: [
      {
        name: "postgres",
        reason: "binds to localhost / loopback (unreachable from sandbox)",
      },
    ],
    classifications: [{ name: "local", kind: "local-path" }],
  };

  const bootstrap = createBootstrap(CLAUDE_CODE);
  const script = [
    bootstrap.renderEnrichmentSetup(),
    bootstrap.renderEnrichmentInstalls({ codePlan }),
    bootstrap.renderEnrichmentConfig({ codePlan }),
    bootstrap.renderEnrichmentCompletion([
      { step: EnrichmentStepId.Setup, ok: true },
    ]),
  ].join("\n");

  expect(script).toContain(
    'SUDO=""; if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi',
  );
  expect(script).toContain(ZSTD_INSTALL);
  expect(script).toContain("command -v dnf >/dev/null && dnf install -y zstd");
  expect(script).toContain("command -v apk >/dev/null && apk add zstd");
  expect(script).toContain("command -v yum >/dev/null && yum install -y zstd");
  expect(script).not.toContain(["SANDHOP", "LOW", "PRIORITY"].join("_"));
  expect(script).not.toContain(["nice", "-n"].join(" "));
  expect(script).not.toContain(["io", "nice"].join(""));
  expect(script).toContain("curl -fsSL https://bun.sh/install | bash");
  expect(script).toContain("curl -LsSf https://astral.sh/uv/install.sh | sh");
  expect(script).toContain("cd '/home/user/mcp' && npm ci");
  expect(script).toContain("set -e");
  expect(script).toContain("node -e");
  expect(script).toContain("$HOME/.claude.json");
  expect(script).toContain("/home/user/mcp/server.js");
  expect(script).toContain("touch /tmp/sandhop-enriched");
  expect(script).toContain(
    'echo "[sandhop] mcp skipped: postgres (binds to localhost / loopback (unreachable from sandbox))"',
  );
  expect(script).toContain('echo "[sandhop] enrichment summary"');
  expect(script).toContain('echo "[sandhop] ok: setup"');
  expect(script.indexOf("cd '\\''/home/user/mcp'\\'' && npm ci")).toBeLessThan(
    script.indexOf("$HOME/.claude.json"),
  );
  expect(script.indexOf("$HOME/.claude.json")).toBeLessThan(
    script.indexOf("touch /tmp/sandhop-enriched"),
  );
});

test("BootstrapService wraps each reinstall command with a bounded timeout", () => {
  const script = createBootstrap(CLAUDE_CODE).renderReinstall([
    "echo one",
    "echo 'two'",
  ]);

  expect(script).toContain(
    "timeout 180 sh -lc 'echo one' || { echo \"[sandhop] reinstall step failed: echo one\" >&2; true; }",
  );
  expect(script).toContain("timeout 180 sh -lc 'echo '\\''two'\\'''");
  expect(script).toContain("export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1");
});

test("BootstrapService MCP node eval commands single-quote scripts", () => {
  const home = mkdtempSync(join(tmpdir(), "sandhop-mcp-eval-"));
  const pwned = join(home, "PWNED");
  const codePlan: CodePlan = {
    mappings: [],
    rewrites: [
      {
        name: "local",
        transport: "stdio",
        command: "node",
        args: [`x;$(touch ${pwned})'`],
      },
    ],
    runtimes: new Set(),
    installCmds: [],
    referencedFiles: [],
    envRefs: [],
    excluded: [],
    classifications: [{ name: "local", kind: "local-path" }],
  };
  const claudeScript = createBootstrap(CLAUDE_CODE).renderEnrichmentConfig({
    codePlan,
  });
  const codexScript = createBootstrap(CODEX).renderEnrichmentConfig({
    codePlan,
  });
  const evalCommands = [
    ...claudeScript.split("\n"),
    ...codexScript.split("\n"),
  ].filter((command) => command.startsWith("node -e "));

  expect(evalCommands).toHaveLength(2);
  expect(evalCommands.every((command) => command.startsWith("node -e '"))).toBe(
    true,
  );

  execFileSync("bash", ["-lc", claudeScript], { env: { HOME: home } });

  expect(existsSync(pwned)).toBe(false);
});

test("BootstrapService merges Claude MCP servers into existing claude.json without clobbering preseed keys", () => {
  const home = mkdtempSync(join(tmpdir(), "sandhop-claude-"));
  const remoteProj = join(home, "project");
  const codePlan: CodePlan = {
    mappings: [],
    rewrites: [
      {
        name: "local",
        transport: "stdio",
        command: "node",
        args: ["/home/user/mcp/server.js"],
        cwd: "/home/user/mcp",
      },
    ],
    runtimes: new Set(),
    installCmds: [],
    referencedFiles: [],
    envRefs: [],
    excluded: [],
    classifications: [{ name: "local", kind: "local-path" }],
  };
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      projects: {
        [remoteProj]: {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
      customApiKeyResponses: { approved: ["last20"], rejected: [] },
      mcpServers: { stale: { command: "old" } },
    }),
  );

  const script = createBootstrap(CLAUDE_CODE).renderEnrichmentConfig({
    codePlan,
  });

  expect(script).not.toContain("cat >");
  execFileSync("bash", ["-lc", script], { env: { HOME: home } });

  const parsed = JSON.parse(
    readFileSync(join(home, ".claude.json"), "utf8"),
  ) as {
    hasCompletedOnboarding: boolean;
    projects: Record<
      string,
      {
        hasTrustDialogAccepted: boolean;
        hasCompletedProjectOnboarding: boolean;
      }
    >;
    customApiKeyResponses: { approved: string[]; rejected: string[] };
    mcpServers: Record<string, unknown>;
  };
  expect(parsed.hasCompletedOnboarding).toBe(true);
  expect(parsed.projects[remoteProj]).toEqual({
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  });
  expect(parsed.customApiKeyResponses).toEqual({
    approved: ["last20"],
    rejected: [],
  });
  expect(parsed.mcpServers).toEqual({
    local: {
      type: "stdio",
      command: "node",
      args: ["/home/user/mcp/server.js"],
      cwd: "/home/user/mcp",
    },
  });
});

test("BootstrapService prunes stale Codex MCP tables before appending rewritten MCP config", () => {
  const codePlan: CodePlan = {
    mappings: [],
    rewrites: [
      {
        name: "local",
        transport: "stdio",
        command: "node",
        args: ["/home/user/mcp/server.js"],
      },
    ],
    runtimes: new Set(),
    installCmds: [],
    referencedFiles: [],
    envRefs: [],
    excluded: [],
    classifications: [{ name: "local", kind: "local-path" }],
  };

  const script = createBootstrap(CODEX).renderEnrichmentConfig({ codePlan });

  expect(script).toContain("node -e");
  expect(script).toContain("[mcp_servers");
  expect(script).toContain('cat >> "$HOME/.codex/config.toml"');
  const delimiter = script.match(/<<'(SANDHOP_MCP_CONFIG_\d+)'/)?.[1];
  if (delimiter === undefined) throw new Error("Missing MCP heredoc delimiter");
  expect(delimiter).not.toBe("SANDHOP_MCP_CONFIG");
  expect(script).toContain(`\n${delimiter}`);
});
