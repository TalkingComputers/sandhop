import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { runEnrichment } from "../../src/cli/enrich.js";
import {
  EnrichmentStepId,
  type EnrichmentProgressEvent,
} from "../../src/core/ports/progress.js";
import type { ExecOptions, RunResult } from "../../src/core/ports/provider.js";
import { FakeHost } from "../fakes/host.js";
import { FakeSandbox } from "../fakes/provider.js";

class FailingMcpSandbox extends FakeSandbox {
  async exec(cmd: string, opts?: ExecOptions): Promise<RunResult> {
    if (cmd.includes("/tmp/sandhop-mcp-0-") && cmd.includes("zstd -d")) {
      this.execs.push(cmd);
      this.execOptions.push(opts);
      return { exitCode: 1, stdout: "", stderr: "npm run build failed" };
    }
    return super.exec(cmd, opts);
  }
}

test("runEnrichment sends profile and MCP roots inline, uploads sourced files, writes config, and marks completion", async () => {
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
      "/home/local/.codex/AGENTS.md": "agents",
      "/home/local/.env.d/mcp.env": "TOKEN=value\n",
      "/home/local/mcp/package.json": "{}",
      "/home/local/mcp/package-lock.json": "{}",
      "/home/local/mcp/server.js": "",
    },
  });
  const sandbox = new FakeSandbox("sbx-1", "/home/user");
  const events: EnrichmentProgressEvent[] = [];

  const steps = await runEnrichment(
    {
      agent: "codex",
      cwd: "/workspace/project",
      excludes: ["node_modules"],
      profile: true,
    },
    host,
    sandbox,
    (event): void => {
      events.push(event);
    },
  );

  expect(steps).toHaveLength(7);
  expect(steps.every((step) => step.ok)).toBe(true);
  expect(events).toContainEqual({
    kind: "enrichStep",
    step: EnrichmentStepId.Setup,
    status: "start",
  });
  expect(events).toContainEqual({
    kind: "enrichStep",
    step: EnrichmentStepId.Setup,
    status: "ok",
  });
  expect(events).toContainEqual({
    kind: "transfer",
    transfer: {
      label: "profile",
      phase: "compress",
      bytesDone: 0,
      bytesTotal: 0,
    },
  });
  expect(events).toContainEqual({
    kind: "transfer",
    transfer: {
      label: "mcp-0",
      phase: "extract",
      bytesDone: 7,
      bytesTotal: 7,
    },
  });
  expect(sandbox.pathUploads).toEqual(
    expect.arrayContaining([
      {
        remotePath: expect.stringMatching(
          /\/tmp\/sandhop-profile-.+\.part\.000000$/,
        ),
        localPath: expect.stringMatching(
          new RegExp(`${tmpdir()}/sandhop-profile-.+\\.part\\.000000$`),
        ),
      },
      {
        remotePath: expect.stringMatching(
          /\/tmp\/sandhop-mcp-0-.+\.part\.000000$/,
        ),
        localPath: expect.stringMatching(
          new RegExp(`${tmpdir()}/sandhop-mcp-0-.+\\.part\\.000000$`),
        ),
      },
    ]),
  );
  expect(sandbox.uploads).toContainEqual({
    path: "/home/user/.env.d/mcp.env",
    data: "TOKEN=value\n",
  });
  expect(host.spawnPipeCalls).toEqual(
    expect.arrayContaining([
      expect.stringContaining("zstd -T0 -8 --long=27 --check"),
      expect.stringContaining("--exclude 'node_modules'"),
    ]),
  );
  expect(host.copyCalls[0]!.excludes).toEqual(["node_modules"]);
  const execLog = sandbox.execs.join("\n");
  expect(execLog).not.toContain(["SANDHOP", "LOW", "PRIORITY"].join("_"));
  expect(execLog).not.toContain(["nice", "-n"].join(" "));
  expect(execLog).not.toContain(["io", "nice"].join(""));
  expect(execLog).toContain("cd '/home/user/mcp' && npm ci");
  expect(execLog).toContain('cat >> "$HOME/.codex/config.toml"');
  expect(execLog).toContain("/home/user/mcp/server.js");
  expect(execLog).toContain("[sandhop] enrichment summary");
  expect(execLog).toContain("touch /tmp/sandhop-enriched");
});

test("progress contract has only inline enrichment events", () => {
  const source = readFileSync("src/core/ports/progress.ts", "utf8");

  expect(source).not.toContain(["kind: ", JSON.stringify("done")].join(""));
  expect(source).not.toContain(["ok", "Steps"].join(""));
  expect(source).not.toContain(["total", "Steps"].join(""));
  expect(source).not.toContain(["Push", "Event"].join(""));
  expect(source).not.toContain(["Push", "Listener"].join(""));
});

test("runEnrichment keeps best-effort steps isolated and marks completion after MCP transfer failure", async () => {
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

  const steps = await runEnrichment(
    {
      agent: "claude-code",
      cwd: "/workspace/project",
      excludes: [],
      profile: true,
    },
    host,
    sandbox,
  );

  expect(steps).toContainEqual({
    step: EnrichmentStepId.McpCodeTransfer,
    ok: false,
    error: expect.stringContaining("Transfer failed for mcp-0"),
  });
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
  expect(log).toContain("[sandhop] step failed: mcp_code_transfer");
  expect(log).not.toContain("cd '/home/user/mcp' && npm ci");
  expect(log).toContain("[sandhop] enrichment summary");
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
      agent: "claude-code",
      cwd: "/home/local/work",
      excludes: ["dist"],
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

  expect(host.spawnPipeCalls).toEqual(
    expect.arrayContaining([
      expect.stringContaining("-C '/home/local/hook-app' ."),
      expect.stringContaining("-C '/home/local/.claude' 'statusline.sh'"),
      expect.stringContaining("-C '/home/local/bin' 'api-key-helper.sh'"),
      expect.stringContaining(
        "-C '/home/local/work/scripts' 'project-hook.py'",
      ),
      expect.stringContaining("--exclude 'dist'"),
    ]),
  );
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
