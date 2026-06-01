import { expect, test } from "vitest";
import { CODEX } from "../../../src/agents/codex.js";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { BootstrapService } from "../../../src/core/services/bootstrap.js";
import { buildManifest } from "../../../src/core/manifest.js";
import type { CodePlan } from "../../../src/core/services/mcp-code.js";

const manifest = buildManifest({
  agent: "claude-code",
  cliVersion: "2.1.160",
  originalCwd: "/workspace/project",
  sessionId: "session-id",
  transcriptName: "session-id.jsonl",
  ts: 1,
});

test("BootstrapService installs exact CLI version, restores tar and transcript, and never sources local secret dirs", () => {
  const script = new BootstrapService(CLAUDE_CODE).render(manifest, {
    hasProfile: true,
  });

  expect(script).toContain("npm i -g @anthropic-ai/claude-code@2.1.160");
  expect(script).toContain("tar -xzf /tmp/bundle.tgz -C /home/user/project");
  expect(script).toContain('cp /tmp/transcript.jsonl "$dest"');
  expect(script).toContain("tar -xzf /tmp/profile.tgz -C $HOME");
  expect(script).toContain("KEEPON_RESTORE_OK");
  expect(script).not.toContain("for f in");
});

test("BootstrapService enables tailscale binary mode when requested", () => {
  const script = new BootstrapService(CLAUDE_CODE).render(manifest, {
    hasProfile: false,
    tailscale: { sandboxId: "sbx-1" },
  });

  expect(script).toContain("curl -fsSL https://tailscale.com/install.sh | sh");
  expect(script).toContain('--hostname="keepon-sbx-1"');
});

test("BootstrapService restores MCP code, installs runtimes and deps, and writes rewritten MCP config", () => {
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
    excluded: [],
    classifications: [{ name: "local", kind: "local-path" }],
  };

  const script = new BootstrapService(CLAUDE_CODE).render(manifest, {
    hasProfile: false,
    codePlan,
  });

  expect(script).toContain("curl -fsSL https://bun.sh/install | bash");
  expect(script).toContain("curl -LsSf https://astral.sh/uv/install.sh | sh");
  expect(script).toContain("tar -xzf /tmp/mcp-code.tgz -C $HOME");
  expect(script).toContain("cd /home/user/mcp && npm ci");
  expect(script).toContain(
    "cat > /home/user/project/.mcp.json <<'KEEPON_MCP_CONFIG'",
  );
  expect(script).toContain('"/home/user/mcp/server.js"');
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

  const script = new BootstrapService(CODEX).render(
    { ...manifest, agent: "codex", cliVersion: "0.136.0" },
    { hasProfile: false, codePlan },
  );

  expect(script).toContain("node -e");
  expect(script).toContain("[mcp_servers");
  expect(script).toContain('cat >> "$HOME/.codex/config.toml"');
});
