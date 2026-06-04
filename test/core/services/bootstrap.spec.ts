import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CODEX } from "../../../src/agents/codex.js";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { BootstrapService } from "../../../src/core/services/bootstrap.js";
import { buildManifest } from "../../../src/core/manifest.js";
import type { CodePlan } from "../../../src/core/services/mcp-code.js";

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

test("BootstrapService core installs exact CLI version, places transcript, and skips enrichment without zstd or apt", () => {
  const script = new BootstrapService(CLAUDE_CODE).render(manifest, {});

  expect(script).toContain(
    'npm i -g @anthropic-ai/claude-code@2.1.160 || $SUDO env PATH="$PATH" npm i -g @anthropic-ai/claude-code@2.1.160',
  );
  expect(script).not.toContain("zstd");
  expect(script).not.toContain("apt-get");
  expect(script).toContain(
    'SUDO=""; if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi',
  );
  expect(script).toContain(
    'ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) TTYD_ARCH=aarch64; CF_ARCH=arm64;; *) TTYD_ARCH=x86_64; CF_ARCH=amd64;; esac',
  );
  expect(script).toContain(
    "curl -fsSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${TTYD_ARCH} -o /usr/local/bin/ttyd",
  );
  expect(script).toContain('$SUDO mkdir -p "/private/tmp/sandhop-codex2"');
  expect(script).toContain(
    '$SUDO chown -R "$(id -u):$(id -g)" "/private/tmp/sandhop-codex2"',
  );
  expect(script).toContain(
    'git config --global --add safe.directory "/private/tmp/sandhop-codex2"',
  );
  expect(script).toContain(
    'tar -xzf /tmp/bundle.tgz -C "/private/tmp/sandhop-codex2"',
  );
  expect(
    script.indexOf('$SUDO mkdir -p "/private/tmp/sandhop-codex2"'),
  ).toBeLessThan(
    script.indexOf(
      '$SUDO chown -R "$(id -u):$(id -g)" "/private/tmp/sandhop-codex2"',
    ),
  );
  expect(
    script.indexOf(
      '$SUDO chown -R "$(id -u):$(id -g)" "/private/tmp/sandhop-codex2"',
    ),
  ).toBeLessThan(
    script.indexOf(
      'git config --global --add safe.directory "/private/tmp/sandhop-codex2"',
    ),
  );
  expect(
    script.indexOf(
      'git config --global --add safe.directory "/private/tmp/sandhop-codex2"',
    ),
  ).toBeLessThan(
    script.indexOf('tar -xzf /tmp/bundle.tgz -C "/private/tmp/sandhop-codex2"'),
  );
  expect(
    script.indexOf('tar -xzf /tmp/bundle.tgz -C "/private/tmp/sandhop-codex2"'),
  ).toBeLessThan(script.indexOf('cp /tmp/transcript.jsonl "$dest"'));
  expect(script).toContain('cp /tmp/transcript.jsonl "$dest"');
  expect(script).toContain("SANDHOP_RESTORE_OK");
  expect(script).not.toContain("profile.tgz");
  expect(script).not.toContain("for f in");
});

test("BootstrapService quotes remote project shell paths with spaces", () => {
  const spacedManifest = buildManifest({
    agent: "claude-code",
    cliVersion: "2.1.160",
    cwd: "/Users/alice/My Project",
    sessionId: "session-id",
    transcriptName: "session-id.jsonl",
    ts: 1,
  });
  const script = new BootstrapService(CLAUDE_CODE).render(spacedManifest, {});

  expect(script).toContain('$SUDO mkdir -p "/Users/alice/My Project"');
  expect(script).toContain(
    'tar -xzf /tmp/bundle.tgz -C "/Users/alice/My Project"',
  );
});

test("BootstrapService injects transport steps before agent install", () => {
  const script = new BootstrapService(CLAUDE_CODE).render(manifest, {
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
    installCmds: ["cd /home/user/mcp && npm ci"],
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

  const bootstrap = new BootstrapService(CLAUDE_CODE);
  const script = [
    bootstrap.renderEnrichmentInstalls({ codePlan }),
    bootstrap.renderEnrichmentConfig(manifest.remoteProj, { codePlan }),
    bootstrap.renderEnrichmentCompletion([]),
  ].join("\n");

  expect(script).toContain(
    'SUDO=""; if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi',
  );
  expect(script).toContain(ZSTD_INSTALL);
  expect(script).toContain("command -v dnf >/dev/null && dnf install -y zstd");
  expect(script).toContain("command -v apk >/dev/null && apk add zstd");
  expect(script).toContain("command -v yum >/dev/null && yum install -y zstd");
  expect(script).toContain('SANDHOP_LOW_PRIORITY="nice -n 19"');
  expect(script).toContain("nice -n 19 ionice -c3");
  expect(script).toContain(
    "$SANDHOP_LOW_PRIORITY sh -lc 'curl -fsSL https://bun.sh/install | bash'",
  );
  expect(script).toContain(
    "$SANDHOP_LOW_PRIORITY sh -lc 'curl -LsSf https://astral.sh/uv/install.sh | sh'",
  );
  expect(script).toContain(
    "$SANDHOP_LOW_PRIORITY sh -lc 'cd /home/user/mcp && npm ci'",
  );
  expect(script).not.toContain("set -e");
  expect(script).toContain(
    "|| { echo \"[sandhop] step failed: \\$SANDHOP_LOW_PRIORITY sh -lc 'curl -fsSL https://bun.sh/install | bash'\" >&2; true; }",
  );
  expect(script).toContain(
    "|| { echo \"[sandhop] step failed: \\$SANDHOP_LOW_PRIORITY sh -lc 'curl -LsSf https://astral.sh/uv/install.sh | sh'\" >&2; true; }",
  );
  expect(script).toContain(
    "|| { echo \"[sandhop] step failed: \\$SANDHOP_LOW_PRIORITY sh -lc 'cd /home/user/mcp && npm ci'\" >&2; true; }",
  );
  expect(script).toContain("node -e");
  expect(script).toContain("$HOME/.claude.json");
  expect(script).toContain("/home/user/mcp/server.js");
  expect(script).toContain("touch /tmp/sandhop-enriched");
  expect(script).toContain(
    'echo "[sandhop] mcp skipped: postgres (binds to localhost / loopback (unreachable from sandbox))"',
  );
  expect(script).toContain('echo "[sandhop] enrichment summary"');
  expect(script.indexOf("cd /home/user/mcp && npm ci")).toBeLessThan(
    script.indexOf("$HOME/.claude.json"),
  );
  expect(script.indexOf("$HOME/.claude.json")).toBeLessThan(
    script.indexOf("touch /tmp/sandhop-enriched"),
  );
  expect(script).not.toContain("mcp-code.tgz");
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

  const script = new BootstrapService(CLAUDE_CODE).renderEnrichmentConfig(
    remoteProj,
    { codePlan },
  );

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
      transport: "stdio",
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

  const bootstrap = new BootstrapService(CODEX);
  const script = [
    bootstrap.renderEnrichmentInstalls({ codePlan }),
    bootstrap.renderEnrichmentConfig(manifest.remoteProj, { codePlan }),
    bootstrap.renderEnrichmentCompletion([]),
  ].join("\n");

  expect(script).toContain("node -e");
  expect(script).toContain("[mcp_servers");
  expect(script).toContain('cat >> "$HOME/.codex/config.toml"');
});
