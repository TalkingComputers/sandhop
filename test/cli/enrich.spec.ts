import { afterEach, expect, test, vi } from "vitest";
import type { RunResult } from "../../src/core/ports/provider.js";
import type { EnrichmentStepResult } from "../../src/core/services/bootstrap.js";
import { runEnrichCli, runEnrichment } from "../../src/cli/enrich.js";
import { FakeHost } from "../fakes/host.js";
import { FakeProvider, FakeSandbox } from "../fakes/provider.js";

class FailingMcpSandbox extends FakeSandbox {
  async exec(cmd: string): Promise<RunResult> {
    if (cmd.includes("/tmp/sandhop-mcp-0-") && cmd.includes("zstd -d")) {
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

const originalSandhopStrict = process.env["SANDHOP_STRICT"];

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../../src/providers/index.js");
  vi.doUnmock("../../src/core/services/enrichment.js");
  vi.resetModules();
  if (originalSandhopStrict === undefined) {
    delete process.env["SANDHOP_STRICT"];
    return;
  }
  process.env["SANDHOP_STRICT"] = originalSandhopStrict;
});

const loadRunEnrichCli = async (steps: EnrichmentStepResult[]) => {
  vi.resetModules();
  vi.doMock("../../src/providers/index.js", () => ({
    PROVIDER_IDS: ["e2b", "modal", "daytona", "vercel"],
    buildProvider: () => ({
      connect: async () => new FakeSandbox("sbx-1", "/home/user"),
    }),
  }));
  vi.doMock("../../src/core/services/enrichment.js", () => ({
    EnrichmentService: class {
      async run(): Promise<EnrichmentStepResult[]> {
        return steps;
      }
    },
  }));
  return import("../../src/cli/enrich.js");
};

const enrichArgv = (extra: string[] = []): string[] => [
  "--sandbox-id",
  "sbx-1",
  "--agent",
  "codex",
  "--cwd",
  "/workspace/project",
  "--provider",
  "e2b",
  ...extra,
];

test("runEnrichCli returns non-zero on top-level failure", async () => {
  const error = vi
    .spyOn(console, "error")
    .mockImplementation((): void => undefined);

  await expect(runEnrichCli([])).resolves.toBe(1);

  expect(error).toHaveBeenCalledWith("--sandbox-id is required");
  error.mockRestore();
});

test("runEnrichCli returns one in strict mode when an enrichment step fails", async () => {
  const { runEnrichCli: runCli } = await loadRunEnrichCli([
    { name: "mcp", ok: false, error: "failed" },
  ]);

  await expect(runCli(enrichArgv(["--strict"]))).resolves.toBe(1);
});

test("runEnrichCli returns zero outside strict mode when an enrichment step fails", async () => {
  const { runEnrichCli: runCli } = await loadRunEnrichCli([
    { name: "mcp", ok: false, error: "failed" },
  ]);

  await expect(runCli(enrichArgv())).resolves.toBe(0);
});

test("runEnrichCli returns one when SANDHOP_STRICT is set and an enrichment step fails", async () => {
  process.env["SANDHOP_STRICT"] = "1";
  const { runEnrichCli: runCli } = await loadRunEnrichCli([
    { name: "mcp", ok: false, error: "failed" },
  ]);

  await expect(runCli(enrichArgv())).resolves.toBe(1);
});

test("runEnrichment sends profile and MCP roots with TransferService, uploads sourced files, writes config, and marks completion", async () => {
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

  await runEnrichment(
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
          /\/tmp\/sandhop-profile-.+\.part\.000000$/,
        ),
        localPath: expect.stringMatching(
          /\/tmp\/sandhop-profile-.+\.part\.000000$/,
        ),
      },
      {
        remotePath: expect.stringMatching(
          /\/tmp\/sandhop-mcp-0-.+\.part\.000000$/,
        ),
        localPath: expect.stringMatching(
          /\/tmp\/sandhop-mcp-0-.+\.part\.000000$/,
        ),
      },
    ]),
  );
  const enrichmentExec = provider.sandbox.execs.find((cmd) =>
    cmd.includes("/tmp/sandhop-enriched"),
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
  expect(execLog).toContain("command -v dnf >/dev/null && dnf install -y zstd");
  expect(execLog).toContain('SANDHOP_LOW_PRIORITY="nice -n 19"');
  expect(execLog).toContain("nice -n 19 ionice -c3");
  expect(execLog).toContain(
    "$SANDHOP_LOW_PRIORITY sh -lc 'cd /home/user/mcp && npm ci'",
  );
  expect(execLog).toContain(
    "$SANDHOP_LOW_PRIORITY sh -lc 'zstd -d --long=27 -c",
  );
  expect(execLog).toContain('cat >> "$HOME/.codex/config.toml"');
  expect(execLog).toContain("/home/user/mcp/server.js");
  expect(enrichmentExec).toContain("[sandhop] enrichment summary");
});

test("runEnrichment re-applies Codex preseed after profile transfer", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.codex/config.toml": 'model = "gpt-5.4"\n',
    },
  });
  const sandbox = new FakeSandbox("sbx-1", "/home/user");

  await runEnrichment(
    {
      sandboxId: "sbx-1",
      agent: "codex",
      cwd: "/workspace/project",
      profile: true,
    },
    host,
    sandbox,
  );

  const profileIndex = sandbox.execs.findIndex(
    (cmd) => cmd.includes("/tmp/sandhop-profile-") && cmd.includes("zstd -d"),
  );
  const preseedIndex = sandbox.execs.findIndex(
    (cmd, index) =>
      index > profileIndex &&
      cmd.includes("/workspace/project") &&
      cmd.includes("trust_level") &&
      cmd.includes("cli_auth_credentials_store"),
  );

  expect(profileIndex).toBeGreaterThan(-1);
  expect(preseedIndex).toBeGreaterThan(profileIndex);
});

test("runEnrichment finishes profile and marker after MCP transfer failure", async () => {
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
  const sandbox = new FailingMcpSandbox("sbx-1", "/home/user");

  await runEnrichment(
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
    ".claude/skills/ship",
  ]);
  const profileIndex = sandbox.execs.findIndex(
    (cmd) => cmd.includes("/tmp/sandhop-profile-") && cmd.includes("zstd -d"),
  );
  const mcpIndex = sandbox.execs.findIndex(
    (cmd) => cmd.includes("/tmp/sandhop-mcp-0-") && cmd.includes("zstd -d"),
  );
  const markerIndex = sandbox.execs.findIndex((cmd) =>
    cmd.includes("touch /tmp/sandhop-enriched"),
  );
  const log = sandbox.execs.join("\n");

  expect(profileIndex).toBeGreaterThan(-1);
  expect(mcpIndex).toBeGreaterThan(profileIndex);
  expect(markerIndex).toBeGreaterThan(mcpIndex);
  expect(log).toContain(
    "[sandhop] step failed: mcp code transfer + config rewrite",
  );
  expect(log).not.toContain(
    "$SANDHOP_LOW_PRIORITY sh -lc 'cd /home/user/mcp && npm ci'",
  );
  expect(log).toContain("[sandhop] enrichment summary");
});

test("runEnrichment runs reinstall commands nice, HTTPS-preferred, fault-isolated, and logged", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude/settings.json": JSON.stringify({
        enabledPlugins: { "serena@official": false },
      }),
      "/home/local/.claude/plugins/known_marketplaces.json": JSON.stringify({
        official: {
          source: { source: "github", repo: "anthropics/claude-plugins" },
        },
      }),
      "/home/local/.claude/plugins/installed_plugins.json": JSON.stringify({
        version: 2,
        plugins: { "serena@official": [{ scope: "user" }] },
      }),
    },
  });
  const sandbox = new FakeSandbox("sbx-1", "/home/user");

  await runEnrichment(
    {
      sandboxId: "sbx-1",
      agent: "claude-code",
      cwd: "/workspace/project",
      profile: true,
    },
    host,
    sandbox,
  );

  const log = sandbox.execs.join("\n");

  expect(log).toContain("CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1");
  expect(log).toContain(
    "$SANDHOP_LOW_PRIORITY sh -lc 'claude plugin marketplace add anthropics/claude-plugins'",
  );
  expect(log).toContain(
    "$SANDHOP_LOW_PRIORITY sh -lc 'claude plugin install serena@official --scope user'",
  );
  expect(log).toContain(
    "$SANDHOP_LOW_PRIORITY sh -lc 'claude plugin disable serena@official'",
  );
  expect(log).toContain("[sandhop] reinstall step failed:");
  expect(log).toContain("touch /tmp/sandhop-enriched");
});

test("runEnrichment ships Claude settings scripts and uploads rewritten settings", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude/settings.json": JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/home/local/hook-app/bin/hook.sh --strict",
                },
                { type: "command", command: "echo inline" },
              ],
            },
          ],
        },
        statusLine: {
          type: "command",
          command: "~/.claude/statusline.sh --json",
        },
        apiKeyHelper: "$HOME/bin/api-key-helper.sh",
      }),
      "/home/local/work/.claude/settings.json": JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "python ./scripts/project-hook.py",
                },
              ],
            },
          ],
        },
      }),
      "/home/local/hook-app/package.json": "{}",
      "/home/local/hook-app/bin/hook.sh": "#!/bin/sh\n",
      "/home/local/hook-app/node_modules/pkg/index.js": "",
      "/home/local/hook-app/.git/config": "",
      "/home/local/.claude/statusline.sh": "#!/bin/sh\n",
      "/home/local/bin/api-key-helper.sh": "#!/bin/sh\n",
      "/home/local/work/scripts/project-hook.py": "#!/usr/bin/env python\n",
    },
    execValues: {
      "git -C /home/local/hook-app/bin rev-parse --show-toplevel":
        "/home/local/hook-app\n",
      "git -C /home/local/hook-app rev-parse --show-toplevel":
        "/home/local/hook-app\n",
    },
  });
  const sandbox = new FakeSandbox("sbx-1", "/home/user");

  await runEnrichment(
    {
      sandboxId: "sbx-1",
      agent: "claude-code",
      cwd: "/home/local/work",
      profile: true,
    },
    host,
    sandbox,
  );

  const userUpload = sandbox.uploads.find(
    (upload) => upload.path === "/home/user/.claude/settings.json",
  );
  const projectUpload = sandbox.uploads.find(
    (upload) => upload.path === "/home/local/work/.claude/settings.json",
  );
  const userSettings = JSON.parse(String(userUpload!.data)) as {
    hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    statusLine: { command: string };
    apiKeyHelper: string;
  };
  const projectSettings = JSON.parse(String(projectUpload!.data)) as {
    hooks: { Stop: { hooks: { command: string }[] }[] };
  };
  const log = sandbox.execs.join("\n");

  expect(host.spawnPipeCalls).toEqual(
    expect.arrayContaining([
      expect.stringContaining("-C '/home/local/hook-app' ."),
      expect.stringContaining("-C '/home/local/.claude' 'statusline.sh'"),
      expect.stringContaining("-C '/home/local/bin' 'api-key-helper.sh'"),
      expect.stringContaining(
        "-C '/home/local/work/scripts' 'project-hook.py'",
      ),
    ]),
  );
  expect(host.spawnPipeCalls).toEqual(
    expect.arrayContaining([
      expect.stringContaining("--exclude 'node_modules'"),
      expect.stringContaining("--exclude '.git'"),
    ]),
  );
  expect(log).toContain('SANDHOP_LOW_PRIORITY="nice -n 19"');
  expect(log).toContain("nice -n 19 ionice -c3");
  expect(log).toContain("step ok: settings scripts transfer + rewrite");
  expect(userSettings.hooks.PreToolUse[0]!.hooks[0]!.command).toBe(
    "/home/user/hook-app/bin/hook.sh --strict",
  );
  expect(userSettings.hooks.PreToolUse[0]!.hooks[1]!.command).toBe(
    "echo inline",
  );
  expect(userSettings.statusLine.command).toBe(
    "/home/user/.claude/statusline.sh --json",
  );
  expect(userSettings.apiKeyHelper).toBe("/home/user/bin/api-key-helper.sh");
  expect(projectSettings.hooks.Stop[0]!.hooks[0]!.command).toBe(
    "python /home/user/work/scripts/project-hook.py",
  );
});
