import { expect, test } from "vitest";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import type { AuthBundle, SessionRef } from "../../../src/core/ports/agent.js";
import type { CodePlan } from "../../../src/core/services/mcp-code.js";
import { BootstrapService } from "../../../src/core/services/bootstrap.js";
import { TeleportService } from "../../../src/core/services/teleport.js";
import { FakeHost } from "../../fakes/host.js";
import { FakeProvider } from "../../fakes/provider.js";

const encoder = new TextEncoder();

test("TeleportService fans out collection, fans in, uploads archive paths, starts HTTPS ttyd with native resume", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const track = async <T>(value: T): Promise<T> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    return value;
  };
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    bytes: {
      "/tmp/bundle.tgz": encoder.encode("bundle"),
      "/home/local/.claude/projects/-workspace-project/session-id.jsonl":
        encoder.encode("transcript"),
      "/tmp/profile.tgz": encoder.encode("profile"),
    },
  });
  const provider = new FakeProvider();
  const session: SessionRef = {
    sessionId: "session-id",
    transcriptPath:
      "/home/local/.claude/projects/-workspace-project/session-id.jsonl",
    transcriptName: "session-id.jsonl",
  };
  const auth: AuthBundle = {
    envs: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
    files: [],
  };
  const service = new TeleportService(provider, CLAUDE_CODE, {
    host,
    snapshot: {
      build: async (cwd, outPath) => {
        host.bytes[outPath] = encoder.encode(`bundle:${cwd}`);
        return track(outPath);
      },
    },
    session: {
      latest: (cwd) => track(session),
      byId: (cwd, sessionId) => track(session),
    },
    profile: {
      build: async (outPath) => {
        host.bytes[outPath] = encoder.encode("profile");
        return track(outPath);
      },
    },
    secrets: {
      collect: (cwd) => track({ envs: { MCP_TOKEN: "mcp-token" }, files: [] }),
    },
    auth: { extract: () => track(auth) },
    version: { detect: () => track("2.1.160") },
    bootstrap: new BootstrapService(CLAUDE_CODE),
  });

  const result = await service.run("/workspace/project", {
    profile: true,
    timeoutMs: 3_600_000,
  });

  expect(maxInFlight).toBe(6);
  expect(provider.creates).toEqual([
    {
      image: "base",
      envs: { MCP_TOKEN: "mcp-token", ANTHROPIC_API_KEY: "sk-ant-api03-test" },
      timeoutMs: 3_600_000,
    },
  ]);
  expect(provider.sandbox.pathUploads).toEqual([
    {
      remotePath: "/tmp/bundle.tgz",
      localPath: expect.stringMatching(/bundle\.tgz$/),
    },
    {
      remotePath: "/tmp/profile.tgz",
      localPath: expect.stringMatching(/profile\.tgz$/),
    },
  ]);
  expect(provider.sandbox.uploads.map((upload) => upload.path)).toEqual([
    "/tmp/transcript.jsonl",
  ]);
  expect(provider.sandbox.spawns[0]).toContain("ttyd -p 7681 -W -c keepon:");
  expect(provider.sandbox.spawns[0]).toContain(
    "bash -lc 'cd /home/user/project && claude --resume session-id'",
  );
  expect(provider.sandbox.spawns[0]).not.toContain("for f in");
  expect(provider.sandbox.exposedPorts).toEqual([7681]);
  expect(result.url).toBe("https://sandbox-sbx-1-7681.example");
  expect(result.user).toBe("keepon");
  expect(result.pass).toMatch(/^[A-Za-z0-9_-]{24}$/);
});

test("TeleportService uses tailscale private mode without exposing a public provider port", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    bytes: {
      "/tmp/bundle.tgz": encoder.encode("bundle"),
      "/home/local/.claude/projects/-workspace-project/session-id.jsonl":
        encoder.encode("transcript"),
    },
  });
  const provider = new FakeProvider();
  const session: SessionRef = {
    sessionId: "session-id",
    transcriptPath:
      "/home/local/.claude/projects/-workspace-project/session-id.jsonl",
    transcriptName: "session-id.jsonl",
  };
  const service = new TeleportService(provider, CLAUDE_CODE, {
    host,
    snapshot: { build: async () => "/tmp/bundle.tgz" },
    session: { latest: async () => session, byId: async () => session },
    profile: { build: async () => null },
    secrets: { collect: async () => ({ envs: {}, files: [] }) },
    auth: {
      extract: async () => ({
        envs: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
        files: [],
      }),
    },
    version: { detect: async () => "2.1.160" },
    bootstrap: new BootstrapService(CLAUDE_CODE),
  });

  const result = await service.run("/workspace/project", {
    profile: false,
    tailscale: { authKey: "tskey-auth-test" },
    timeoutMs: 3_600_000,
  });

  expect(provider.creates[0]!.envs).toEqual({
    ANTHROPIC_API_KEY: "sk-ant-api03-test",
    TS_AUTHKEY: "tskey-auth-test",
  });
  expect(provider.sandbox.spawns[0]).toContain(
    "ttyd -i 127.0.0.1 -p 7681 -W -c keepon:",
  );
  expect(provider.sandbox.exposedPorts).toEqual([]);
  expect(result.url).toBe("http://keepon-sbx-1.tailnet.test:7681");
});

test("TeleportService uploads MCP code archives with uploadPath and uploads referenced files as small writes", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    bytes: {
      "/tmp/bundle.tgz": encoder.encode("bundle"),
      "/tmp/mcp-code.tgz": encoder.encode("mcp-code"),
      "/home/local/.claude/projects/-workspace-project/session-id.jsonl":
        encoder.encode("transcript"),
    },
  });
  const provider = new FakeProvider();
  const session: SessionRef = {
    sessionId: "session-id",
    transcriptPath:
      "/home/local/.claude/projects/-workspace-project/session-id.jsonl",
    transcriptName: "session-id.jsonl",
  };
  const codePlan: CodePlan = {
    mappings: [{ localPath: "/home/local/mcp", sandboxPath: "/home/user/mcp" }],
    rewrites: [],
    runtimes: new Set(),
    installCmds: [],
    referencedFiles: ["/home/local/.env.d/mcp.env"],
    envRefs: ["MCP_TOKEN"],
    excluded: [],
    classifications: [{ name: "local", kind: "local-path" }],
  };
  const service = new TeleportService(provider, CLAUDE_CODE, {
    host,
    snapshot: { build: async () => "/tmp/bundle.tgz" },
    session: { latest: async () => session, byId: async () => session },
    profile: { build: async () => null },
    mcpCode: { build: async () => codePlan },
    secrets: {
      collect: async () => ({
        envs: { MCP_TOKEN: "token" },
        files: [{ path: "$HOME/.env.d/mcp.env", content: "MCP_TOKEN=token\n" }],
      }),
    },
    auth: {
      extract: async () => ({
        envs: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
        files: [],
      }),
    },
    version: { detect: async () => "2.1.160" },
    bootstrap: new BootstrapService(CLAUDE_CODE),
  });

  await service.run("/workspace/project", {
    profile: false,
    timeoutMs: 3_600_000,
  });

  expect(provider.sandbox.pathUploads).toEqual([
    { remotePath: "/tmp/bundle.tgz", localPath: "/tmp/bundle.tgz" },
    {
      remotePath: "/tmp/mcp-code.tgz",
      localPath: expect.stringMatching(/mcp-code\.tgz$/),
    },
  ]);
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/home/user/.env.d/mcp.env",
    data: "MCP_TOKEN=token\n",
  });
  expect(provider.sandbox.execs[0]).toContain("tar -xzf /tmp/mcp-code.tgz");
});
