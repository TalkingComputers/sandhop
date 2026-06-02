import { expect, test } from "vitest";
import type { RunResult } from "../../src/core/ports/provider.js";
import { enrichSandbox } from "../../src/cli/enrich.js";
import { FakeHost } from "../fakes/host.js";
import { FakeProvider, FakeSandbox } from "../fakes/provider.js";

class FailingMcpSandbox extends FakeSandbox {
  async exec(cmd: string): Promise<RunResult> {
    if (cmd.includes("/tmp/keepon-mcp-0-") && cmd.includes("zstd -d")) {
      this.execs.push(cmd);
      return {
        exitCode: 1,
        stdout: "",
        stderr: "npm run build failed",
      };
    }
    return super.exec(cmd);
  }
}

test("enrichSandbox sends profile and MCP roots with TransferService, uploads sourced files, writes config, and marks completion", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.codex/config.toml": `
[mcp_servers.local]
command = "node"
args = ["/home/local/mcp/server.js"]
cwd = "/home/local/mcp"

[mcp_servers.bash]
command = "bash"
args = ["-lc", "source /home/local/.env.d/mcp.env && /home/local/mcp/server.js"]
cwd = "/home/local/mcp"
`,
      "/home/local/.env.d/mcp.env": "TOKEN=value\n",
      "/home/local/mcp/package.json": "{}",
      "/home/local/mcp/package-lock.json": "{}",
      "/home/local/mcp/server.js": "",
    },
  });
  const provider = new FakeProvider();

  await enrichSandbox(
    {
      sandboxId: "sbx-1",
      agent: "codex",
      cwd: "/workspace/project",
      profile: true,
    },
    host,
    provider.sandbox,
  );

  expect(provider.sandbox.pathUploads).toEqual(
    expect.arrayContaining([
      {
        remotePath: expect.stringMatching(
          /\/tmp\/keepon-profile-.+\.part\.000000$/,
        ),
        localPath: expect.stringMatching(
          /\/tmp\/keepon-profile-.+\.part\.000000$/,
        ),
      },
      {
        remotePath: expect.stringMatching(
          /\/tmp\/keepon-mcp-0-.+\.part\.000000$/,
        ),
        localPath: expect.stringMatching(
          /\/tmp\/keepon-mcp-0-.+\.part\.000000$/,
        ),
      },
    ]),
  );
  const enrichmentExec = provider.sandbox.execs.find((cmd) =>
    cmd.includes("/tmp/keepon-enriched"),
  );
  const execLog = provider.sandbox.execs.join("\n");
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/home/user/.env.d/mcp.env",
    data: "TOKEN=value\n",
  });
  expect(host.spawnPipeCalls).toEqual(
    expect.arrayContaining([
      expect.stringContaining("zstd -T0 -8 --long=27 --check"),
    ]),
  );
  expect(execLog).toContain("command -v zstd || sudo apt-get install -y zstd");
  expect(execLog).toContain('KEEPON_LOW_PRIORITY="nice -n 19"');
  expect(execLog).toContain("nice -n 19 ionice -c3");
  expect(execLog).toContain(
    "$KEEPON_LOW_PRIORITY sh -lc 'cd /home/user/mcp && npm ci'",
  );
  expect(execLog).toContain(
    "$KEEPON_LOW_PRIORITY sh -lc 'zstd -d --long=27 -c",
  );
  expect(execLog).toContain('cat >> "$HOME/.codex/config.toml"');
  expect(execLog).toContain("/home/user/mcp/server.js");
  expect(enrichmentExec).toContain("[keepon] enrichment summary");
});

test("enrichSandbox finishes profile and marker after MCP transfer failure", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude/settings.json": "{}",
      "/home/local/.claude/skills/ship/SKILL.md": "ship",
      "/home/local/.claude.json": JSON.stringify({
        mcpServers: {
          mercury: {
            command: "node",
            args: ["/home/local/mcp/server.js"],
            cwd: "/home/local/mcp",
          },
        },
      }),
      "/home/local/mcp/package.json": "{}",
      "/home/local/mcp/package-lock.json": "{}",
      "/home/local/mcp/server.js": "",
    },
  });
  const sandbox = new FailingMcpSandbox("sbx-1");

  await enrichSandbox(
    {
      sandboxId: "sbx-1",
      agent: "claude-code",
      cwd: "/workspace/project",
      profile: true,
    },
    host,
    sandbox,
  );

  expect(host.copyCalls[0]!.entries).toEqual([
    ".claude/settings.json",
    ".claude/skills",
  ]);
  const profileIndex = sandbox.execs.findIndex(
    (cmd) => cmd.includes("/tmp/keepon-profile-") && cmd.includes("zstd -d"),
  );
  const mcpIndex = sandbox.execs.findIndex(
    (cmd) => cmd.includes("/tmp/keepon-mcp-0-") && cmd.includes("zstd -d"),
  );
  const markerIndex = sandbox.execs.findIndex((cmd) =>
    cmd.includes("touch /tmp/keepon-enriched"),
  );
  const log = sandbox.execs.join("\n");

  expect(profileIndex).toBeGreaterThan(-1);
  expect(mcpIndex).toBeGreaterThan(profileIndex);
  expect(markerIndex).toBeGreaterThan(mcpIndex);
  expect(log).toContain(
    "[keepon] step failed: mcp code transfer + config rewrite",
  );
  expect(log).toContain("[keepon] enrichment summary");
});
