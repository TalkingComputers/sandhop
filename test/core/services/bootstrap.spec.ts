import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { renderRestoreScript } from "../../../src/core/services/bootstrap.js";
import {
  renderEnrichmentCompletion,
  renderEnrichmentConfig,
  renderEnrichmentInstalls,
  renderEnrichmentSetup,
  renderReinstall,
  uploadEnrichmentScripts,
} from "../../../src/core/services/enrichment-scripts.js";
import {
  renderPathPrep,
  uploadOwnedFiles,
} from "../../../src/core/services/sandbox-files.js";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { CODEX } from "../../../src/agents/codex.js";
import { buildManifest } from "../../../src/core/manifest.js";
import type { Agent } from "../../../src/core/ports/agent.js";
import type { CommandInvocation } from "../../../src/core/ports/provider.js";
import { EnrichmentStepId } from "../../../src/core/ports/progress.js";
import type { CodePlan } from "../../../src/core/services/mcp-code.js";
import { FakeSandbox } from "../../fakes/provider.js";

const tmuxMultiplexer = {
  id: "tmux",
  install: (): string[] => [
    "command -v tmux",
    `printf '%s\\n' 'set -g status off' 'set -g window-size latest' 'set -g focus-events on' 'set -g mouse on' 'set -g history-limit 10000' > "$HOME/.tmux.conf"`,
  ],
  attach: (session: string, command: CommandInvocation): CommandInvocation => ({
    file: "tmux",
    args: ["new", "-A", "-s", session, command.file, ...command.args],
  }),
};

const stageEnrichmentScripts = async (
  agent: Agent,
  codePlan: CodePlan,
  home: string,
): Promise<void> => {
  const sandbox = new FakeSandbox("stage", {
    home,
    username: "user",
    workdir: `${home}/project`,
  });
  await uploadEnrichmentScripts(sandbox, agent, codePlan, home);
  for (const upload of sandbox.uploads) writeFileSync(upload.path, upload.data);
};

const manifest = buildManifest({
  agent: "claude-code",
  cliVersion: "2.1.160",
  cwd: "/private/tmp/sandhop-codex2",
  sessionId: "session-id",
  transcriptName: "session-id.jsonl",
  ts: 1,
});
const ZSTD_INSTALL = "command -v zstd";
const OWNER_SETUP =
  'SANDHOP_OWNER="$(id -u "$SANDHOP_RUNTIME_USER"):$(id -g "$SANDHOP_RUNTIME_USER")"';
test("renderPathPrep sudo-creates and owns the remote project before transfer", () => {
  const script = renderPathPrep(manifest.remoteProj);

  expect(script.split("\n")).toEqual([
    "set -e",
    OWNER_SETUP,
    "mkdir -p /private/tmp/sandhop-codex2",
    `d=/private/tmp/sandhop-codex2; while [ "$d" != "/" ]; do case "$d" in "$SANDHOP_RUNTIME_HOME"/*) chown "$SANDHOP_OWNER" "$d";; esac; d="$(dirname "$d")"; done`,
    OWNER_SETUP,
    'chown -R "$SANDHOP_OWNER" /private/tmp/sandhop-codex2',
  ]);
});

test("uploadOwnedFiles preps dirs once, uploads in parallel, then owns and chmods in one pass", async () => {
  const sandbox = new FakeSandbox("sbx", {
    home: "/Users/local",
    username: "local",
    workdir: "/Users/local",
  });

  await uploadOwnedFiles(
    sandbox,
    [
      {
        path: "/Users/local/.claude/.credentials.json",
        content: "{}",
        mode: "600",
      },
      { path: "/Users/local/.ssh/id_git", content: "PRIVATE", mode: "600" },
      { path: "/Users/local/.ssh/id_git.pub", content: "PUBLIC", mode: "644" },
    ],
    [{ path: "/Users/local/.ssh", mode: "700" }],
  );

  expect(sandbox.uploads).toEqual([
    { path: "/Users/local/.claude/.credentials.json", data: "{}" },
    { path: "/Users/local/.ssh/id_git", data: "PRIVATE" },
    { path: "/Users/local/.ssh/id_git.pub", data: "PUBLIC" },
  ]);
  expect(sandbox.execs).toHaveLength(2);
  expect(sandbox.execs[0]).toContain("mkdir -p /Users/local/.claude");
  expect(sandbox.execs[0]).toContain("mkdir -p /Users/local/.ssh");
  expect(sandbox.execs[1]).toContain(
    `chown "$SANDHOP_OWNER" /Users/local/.claude/.credentials.json`,
  );
  expect(sandbox.execs[1]).toContain(
    `chown "$SANDHOP_OWNER" /Users/local/.ssh/id_git`,
  );
  expect(sandbox.execs[1]).toContain("chmod 700 /Users/local/.ssh");
  expect(sandbox.execs[1]).toContain(
    "chmod 600 /Users/local/.claude/.credentials.json",
  );
  expect(sandbox.execs[1]).toContain("chmod 644 /Users/local/.ssh/id_git.pub");
});

test("renderRestoreScript installs exact CLI version, places transcript, and installs tmux after ttyd before project prep and zstd", () => {
  const script = renderRestoreScript(CLAUDE_CODE, tmuxMultiplexer, manifest, {
    home: "/home/user",
    preSeedScripts: [],
    sidechainNames: [],
  });

  expect(script).toContain(
    "curl -fsSL https://claude.ai/install.sh | bash -s 2.1.160",
  );
  expect(script).toContain('export PATH="$HOME/.local/bin:$PATH"');
  expect(script).toContain("Claude Code version mismatch");
  expect(script).not.toContain("npm i -g @anthropic-ai/claude-code");
  expect(script).not.toContain("zstd");
  expect(script).not.toContain('SUDO=""');
  expect(script).not.toContain("latest/download");
  expect(script.split("\n").slice(1, 4)).toEqual([
    "command -v ttyd",
    "command -v tmux",
    `printf '%s\\n' 'set -g status off' 'set -g window-size latest' 'set -g focus-events on' 'set -g mouse on' 'set -g history-limit 10000' > "$HOME/.tmux.conf"`,
  ]);
  expect(script).toContain(
    "git config --global --add safe.directory /private/tmp/sandhop-codex2",
  );
  expect(script).not.toContain("mkdir -p /private/tmp/sandhop-codex2");
  expect(
    script.indexOf(
      "git config --global --add safe.directory /private/tmp/sandhop-codex2",
    ),
  ).toBeLessThan(script.indexOf('cp /tmp/transcript.jsonl "$dest"'));
  expect(script).not.toContain(
    'chown -R "$SANDHOP_OWNER" /private/tmp/sandhop-codex2',
  );
  expect(script).not.toContain("tar -xzf /tmp/bundle.tgz");
  expect(script).toContain('cp /tmp/transcript.jsonl "$dest"');
  expect(script).toContain("SANDHOP_RESTORE_OK");
  expect(script).not.toContain("profile.tgz");
  expect(script).not.toContain("for f in");
});

test("renderRestoreScript quotes remote project shell paths with metacharacters", () => {
  const spacedManifest = buildManifest({
    agent: "claude-code",
    cliVersion: "2.1.160",
    cwd: "/Users/alice/My Project;$(touch pwn)'",
    sessionId: "session-id",
    transcriptName: "session-id.jsonl",
    ts: 1,
  });
  const prep = renderPathPrep(spacedManifest.remoteProj);
  const script = renderRestoreScript(
    CLAUDE_CODE,
    tmuxMultiplexer,
    spacedManifest,
    {
      home: "/home/user",
      preSeedScripts: [],
      sidechainNames: [],
    },
  );
  const quotedRemoteProj = `"/Users/alice/My Project;\\$(touch pwn)'"`;

  expect(prep).toContain(`mkdir -p ${quotedRemoteProj}`);
  expect(prep).toContain(`chown -R "$SANDHOP_OWNER" ${quotedRemoteProj}`);
  expect(script).toContain(
    `git config --global --add safe.directory ${quotedRemoteProj}`,
  );
  expect(script).toContain(
    "dest=/home/user/.claude/projects/-Users-alice-My-Project---touch-pwn--/session-id.jsonl",
  );
  expect(script).not.toContain("tar -xzf /tmp/bundle.tgz");
});

test("renderRestoreScript emits quoted git identity after safe directory when supplied", () => {
  const script = renderRestoreScript(CLAUDE_CODE, tmuxMultiplexer, manifest, {
    home: "/home/user",
    preSeedScripts: [],
    sidechainNames: [],
    gitUserName: "Alice O'Connor",
    gitUserEmail: "alice+test@example.com",
  });

  const safe =
    "git config --global --add safe.directory /private/tmp/sandhop-codex2";
  const name = `git config --global user.name "Alice O'Connor"`;
  const email = "git config --global user.email alice+test\\@example.com";

  expect(script).toContain(safe);
  expect(script).toContain(name);
  expect(script).toContain(email);
  expect(script.indexOf(safe)).toBeLessThan(script.indexOf(name));
  expect(script.indexOf(name)).toBeLessThan(script.indexOf(email));
  expect(script.indexOf(email)).toBeLessThan(
    script.indexOf("dest=/home/user/.claude/projects"),
  );
});

test("renderRestoreScript injects transport steps before agent install", () => {
  const script = renderRestoreScript(CLAUDE_CODE, tmuxMultiplexer, manifest, {
    home: "/home/user",
    preSeedScripts: [],
    sidechainNames: [],
    transportSteps: ["install cloudflared"],
  });

  expect(script).toContain("install cloudflared");
  expect(script.indexOf("install cloudflared")).toBeLessThan(
    script.indexOf("curl -fsSL https://claude.ai/install.sh"),
  );
});

test("enrichment scripts install runtimes and deps, write rewritten MCP config, and mark completion", async () => {
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
    installCmds: ["cd /home/user/mcp && npm ci"],
    excluded: [
      {
        name: "postgres",
        reason: "binds to localhost / loopback (unreachable from sandbox)",
      },
    ],
    classifications: [{ name: "local", kind: "local-path" }],
  };

  const sandbox = new FakeSandbox("stage", {
    home: "/home/user",
    username: "user",
    workdir: "/home/user/project",
  });
  await uploadEnrichmentScripts(sandbox, CLAUDE_CODE, codePlan, "/home/user");
  const script = [
    renderEnrichmentSetup(),
    renderEnrichmentInstalls(codePlan),
    renderEnrichmentConfig(CLAUDE_CODE, codePlan, "/home/user"),
    renderEnrichmentCompletion([{ step: EnrichmentStepId.Setup, ok: true }]),
  ].join("\n");

  expect(script).not.toContain('SUDO=""');
  expect(script).toContain(ZSTD_INSTALL);
  expect(script).toContain("command -v zstd");
  expect(renderEnrichmentInstalls(codePlan).split("\n")[0]).toBe("set -e");
  expect(script).not.toContain(["SANDHOP", "LOW", "PRIORITY"].join("_"));
  expect(script).not.toContain(["nice", "-n"].join(" "));
  expect(script).not.toContain(["io", "nice"].join(""));
  expect(script).toContain("curl -fsSL https://bun.sh/install | bash");
  expect(script).toContain("curl -LsSf https://astral.sh/uv/install.sh | sh");
  expect(script).toContain("cd /home/user/mcp && npm ci");
  expect(script).toContain("set -e");
  expect(script).not.toContain("node -e");
  expect(script).toContain("node /tmp/sandhop-mcp-merge-");
  expect(sandbox.uploads).toContainEqual({
    path: expect.stringMatching(/^\/tmp\/sandhop-mcp-merge-[0-9a-f]{16}\.js$/),
    data: expect.stringContaining("/home/user/.claude.json"),
  });
  expect(sandbox.uploads).toContainEqual({
    path: expect.stringMatching(/^\/tmp\/sandhop-mcp-merge-[0-9a-f]{16}\.js$/),
    data: expect.stringContaining("/home/user/mcp/server.js"),
  });
  expect(script).toContain("touch /tmp/sandhop-enriched");
  expect(script).toContain(
    "echo '[sandhop] mcp skipped: postgres (binds to localhost / loopback (unreachable from sandbox))'",
  );
  expect(script).toContain('echo "[sandhop] enrichment summary"');
  expect(script).toContain("echo '[sandhop] ok: setup'");
  expect(script.indexOf("cd /home/user/mcp && npm ci")).toBeLessThan(
    script.indexOf("node /tmp/sandhop-mcp-merge-"),
  );
  expect(script.indexOf("node /tmp/sandhop-mcp-merge-")).toBeLessThan(
    script.indexOf("touch /tmp/sandhop-enriched"),
  );
});

test("renderReinstall wraps each reinstall command with a bounded timeout", () => {
  const script = renderReinstall(["echo one", "echo 'two'"]);

  expect(script).toContain("timeout 180 sh -lc 'echo one'");
  expect(script).toContain("timeout 180 sh -lc \"echo 'two'\"");
  expect(script).not.toContain("true");
  expect(script).toContain("export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1");
});

test("MCP node scripts avoid eval", async () => {
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
    excluded: [],
    classifications: [{ name: "local", kind: "local-path" }],
  };
  await stageEnrichmentScripts(CLAUDE_CODE, codePlan, home);
  await stageEnrichmentScripts(CODEX, codePlan, home);
  const claudeScript = renderEnrichmentConfig(CLAUDE_CODE, codePlan, home);
  const codexScript = renderEnrichmentConfig(CODEX, codePlan, home);
  const evalCommands = [
    ...claudeScript.split("\n"),
    ...codexScript.split("\n"),
  ].filter((command) => command.startsWith("node /tmp/sandhop-"));

  expect(evalCommands).toHaveLength(2);
  expect(
    [...claudeScript.split("\n"), ...codexScript.split("\n")].join("\n"),
  ).not.toContain("node -e");
  expect(
    [...claudeScript.split("\n"), ...codexScript.split("\n")].join("\n"),
  ).not.toContain("cat >");
  expect(
    [...claudeScript.split("\n"), ...codexScript.split("\n")].join("\n"),
  ).not.toContain(pwned);

  execFileSync("bash", ["-lc", claudeScript], { env: { HOME: home } });

  expect(existsSync(pwned)).toBe(false);
});

test("merge-mcp-servers merges Claude MCP servers into existing claude.json without clobbering preseed keys", async () => {
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

  await stageEnrichmentScripts(CLAUDE_CODE, codePlan, home);
  const script = renderEnrichmentConfig(CLAUDE_CODE, codePlan, home);

  expect(script).not.toContain("node -e");
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

test("replace-mcp-section replaces stale Codex MCP tables from uploaded script", async () => {
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
    excluded: [],
    classifications: [{ name: "local", kind: "local-path" }],
  };

  const sandbox = new FakeSandbox("stage", {
    home: "/home/user",
    username: "user",
    workdir: "/home/user/project",
  });
  await uploadEnrichmentScripts(sandbox, CODEX, codePlan, "/home/user");
  const script = renderEnrichmentConfig(CODEX, codePlan, "/home/user");

  expect(script).not.toContain("node -e");
  expect(script).not.toContain("[mcp_servers");
  expect(script).not.toContain("cat >>");
  expect(script).toContain("node /tmp/sandhop-mcp-write-");
  expect(sandbox.uploads).toEqual([
    {
      path: expect.stringMatching(
        /^\/tmp\/sandhop-mcp-write-[0-9a-f]{16}\.js$/,
      ),
      data: expect.stringContaining("[mcp_servers.local]"),
    },
  ]);
});
