import { expect, test } from "vitest";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { TTYD_PORT } from "../../../src/core/constants.js";
import type { AuthBundle, SessionRef } from "../../../src/core/ports/agent.js";
import type { Transport } from "../../../src/core/ports/transport.js";
import { BootstrapService } from "../../../src/core/services/bootstrap.js";
import type { SshCollector } from "../../../src/core/services/git-ssh.js";
import { TeleportService } from "../../../src/core/services/teleport.js";
import { PublicTransport } from "../../../src/transports/public.js";
import { FakeHost } from "../../fakes/host.js";
import { FakeProvider } from "../../fakes/provider.js";

const encoder = new TextEncoder();

class RealpathHost extends FakeHost {
  realpaths: string[] = [];

  realpath(path: string): string {
    this.realpaths.push(path);
    return path;
  }
}

const emptyGitSsh: SshCollector = {
  collect: () => ({ files: [], dirs: [] }),
};

test("TeleportService fast core fans out collection, transfers one gzip bundle, starts HTTPS ttyd with native resume, and skips enrichment", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const track = async <T>(value: T): Promise<T> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    return value;
  };
  const host = new RealpathHost({
    home: "/home/local",
    env: {},
    bytes: {
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
  const auth: AuthBundle = {
    envs: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
    files: [],
  };
  const service = new TeleportService(provider, CLAUDE_CODE, {
    host,
    session: {
      latest: (cwd) => track(session),
      byId: (cwd, sessionId) => track(session),
    },
    secrets: {
      collect: (cwd) => track({ envs: { MCP_TOKEN: "mcp-token" }, files: [] }),
    },
    auth: { extract: () => track(auth) },
    version: { detect: () => track("2.1.160") },
    bootstrap: new BootstrapService(CLAUDE_CODE),
    gitSsh: emptyGitSsh,
  });

  const result = await service.run("/workspace/project", {
    excludes: [],
    includes: [],
    transport: new PublicTransport(),
    timeoutMs: 3_600_000,
  });

  expect(maxInFlight).toBe(4);
  expect(host.realpaths).toEqual(["/workspace/project"]);
  expect(provider.creates).toEqual([
    {
      envs: { MCP_TOKEN: "mcp-token", ANTHROPIC_API_KEY: "sk-ant-api03-test" },
      timeoutMs: 3_600_000,
      ports: [TTYD_PORT],
    },
  ]);
  expect(provider.sandbox.pathUploads).toEqual([
    {
      remotePath: expect.stringMatching(
        /\/tmp\/sandhop-bundle-.+\.part\.000000$/,
      ),
      localPath: expect.stringMatching(
        /\/tmp\/sandhop-bundle-.+\.part\.000000$/,
      ),
    },
  ]);
  expect(host.spawnPipeCalls).toEqual([
    expect.stringMatching(
      /tar \$SANDHOP_TAR_MAC_FLAGS -czf '\/tmp\/sandhop-bundle-.+\.tar\.gz' -C '\/workspace\/project' \./,
    ),
  ]);
  expect(host.spawnPipeCalls[0]).toContain("COPYFILE_DISABLE=1");
  expect(host.spawnPipeCalls[0]).toContain("--no-mac-metadata");
  expect(host.spawnPipeCalls[0]).not.toContain("zstd");
  expect(provider.sandbox.execs[0]).toContain(
    "$SUDO mkdir -p '/workspace/project'",
  );
  expect(provider.sandbox.execs[0]).toContain(
    "$SUDO chown -R \"$(id -u):$(id -g)\" '/workspace/project'",
  );
  expect(provider.sandbox.execs[1]).toContain("gzip -t");
  expect(provider.sandbox.execs[1]).toContain("wc -c");
  expect(provider.sandbox.execs[1]).toContain("tar -xzf '/tmp/sandhop-bundle-");
  expect(provider.sandbox.execs[1]).not.toContain("zstd");
  expect(provider.sandbox.execs[1]).not.toContain("apt-get");
  expect(provider.sandbox.execs[2]).not.toContain("zstd");
  expect(provider.sandbox.execs[2]).not.toContain("apt-get");
  expect(provider.sandbox.uploads.map((upload) => upload.path)).toEqual([
    "/tmp/transcript.jsonl",
  ]);
  expect(provider.sandbox.execs[2]).toContain(
    "git config --global --add safe.directory '/workspace/project'",
  );
  expect(provider.sandbox.execs[2]).not.toContain("tar -xzf /tmp/bundle.tgz");
  expect(provider.sandbox.spawns[0]).toContain(
    `ttyd -p ${TTYD_PORT} -W -c 'host-user:`,
  );
  expect(provider.sandbox.spawns[0]).toContain("-c 'host-user:");
  expect(provider.sandbox.spawns[0]).not.toContain("-i 127.0.0.1");
  expect(provider.sandbox.spawns[0]).toContain("bash -lc");
  expect(provider.sandbox.spawns[0]).toContain("claude --resume");
  expect(provider.sandbox.spawns[0]).toContain("'\\''/workspace/project'\\''");
  expect(provider.sandbox.spawns[0]).toContain("'\\''session-id'\\''");
  expect(provider.sandbox.spawns[0]).not.toContain("MCP_TIMEOUT=");
  expect(provider.sandbox.spawns[0]).not.toContain("for f in");
  expect(provider.sandbox.execs).toHaveLength(3);
  expect(provider.sandbox.execs[2]).not.toContain("profile");
  expect(provider.sandbox.execs[2]).not.toContain("mcp");
  expect(provider.sandbox.exposedPorts).toEqual([TTYD_PORT]);
  expect(result.url).toBe(`https://sandbox-sbx-1-${TTYD_PORT}.example`);
  expect(result.user).toBe("host-user");
  expect(result.pass).toMatch(/^[A-Za-z0-9_-]{24}$/);
});

test("TeleportService injects transport bootstrap steps and loopback ttyd bind", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: { MCP_TIMEOUT: "120000" },
    bytes: {
      "/home/local/.claude/projects/-workspace-project/session-id.jsonl":
        encoder.encode("transcript"),
    },
  });
  const provider = new FakeProvider();
  const cloudflaredTransport: Transport = {
    id: "cloudflared",
    ttydBindAddress: () => "127.0.0.1",
    bootstrapSteps: () => ["install cloudflared"],
    expose: async (ctx) => ({ url: `https://cloudflared-${ctx.sandbox.id}` }),
  };
  const session: SessionRef = {
    sessionId: "session-id",
    transcriptPath:
      "/home/local/.claude/projects/-workspace-project/session-id.jsonl",
    transcriptName: "session-id.jsonl",
  };
  const service = new TeleportService(provider, CLAUDE_CODE, {
    host,
    session: { latest: async () => session, byId: async () => session },
    secrets: { collect: async () => ({ envs: {}, files: [] }) },
    auth: {
      extract: async () => ({
        envs: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
        files: [],
      }),
    },
    version: { detect: async () => "2.1.160" },
    bootstrap: new BootstrapService(CLAUDE_CODE),
    gitSsh: emptyGitSsh,
  });

  const result = await service.run("/workspace/project", {
    excludes: [],
    includes: [],
    transport: cloudflaredTransport,
    timeoutMs: 3_600_000,
  });

  expect(provider.creates[0]!.envs).toEqual({
    ANTHROPIC_API_KEY: "sk-ant-api03-test",
  });
  expect(provider.sandbox.execs[2]).toContain("install cloudflared");
  expect(provider.sandbox.spawns[0]).toContain(
    `ttyd -i '127.0.0.1' -p ${TTYD_PORT} -W -c 'host-user:`,
  );
  expect(provider.sandbox.spawns[0]).toContain(
    "MCP_TIMEOUT='\\''120000'\\'' claude --resume",
  );
  expect(provider.sandbox.exposedPorts).toEqual([]);
  expect(result.url).toBe("https://cloudflared-sbx-1");
});

test("TeleportService uploads core secret and auth files but leaves MCP code to enrichment", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    bytes: {
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
    session: { latest: async () => session, byId: async () => session },
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
    gitSsh: emptyGitSsh,
  });

  await service.run("/workspace/project", {
    excludes: [],
    includes: [],
    transport: new PublicTransport(),
    timeoutMs: 3_600_000,
  });

  expect(provider.sandbox.pathUploads).toEqual([
    {
      remotePath: expect.stringMatching(
        /\/tmp\/sandhop-bundle-.+\.part\.000000$/,
      ),
      localPath: expect.stringMatching(
        /\/tmp\/sandhop-bundle-.+\.part\.000000$/,
      ),
    },
  ]);
  expect(provider.sandbox.uploads).not.toContainEqual({
    path: "/tmp/bundle.tgz",
    data: encoder.encode("archive"),
  });
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/home/user/.env.d/mcp.env",
    data: "MCP_TOKEN=token\n",
  });
  expect(provider.sandbox.execs[2]).not.toContain("mcp-code");
});

test("TeleportService restore failure surfaces stdout when stderr is empty", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    bytes: {
      "/home/local/.claude/projects/-workspace-project/session-id.jsonl":
        encoder.encode("transcript"),
    },
  });
  const provider = new FakeProvider();
  provider.sandbox.execResults.push(
    { exitCode: 0, stdout: "", stderr: "" },
    { exitCode: 0, stdout: "", stderr: "" },
    { exitCode: 1, stdout: "daytona npm EACCES output", stderr: "" },
  );
  const session: SessionRef = {
    sessionId: "session-id",
    transcriptPath:
      "/home/local/.claude/projects/-workspace-project/session-id.jsonl",
    transcriptName: "session-id.jsonl",
  };
  const service = new TeleportService(provider, CLAUDE_CODE, {
    host,
    session: { latest: async () => session, byId: async () => session },
    secrets: { collect: async () => ({ envs: {}, files: [] }) },
    auth: {
      extract: async () => ({
        envs: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
        files: [],
      }),
    },
    version: { detect: async () => "2.1.160" },
    bootstrap: new BootstrapService(CLAUDE_CODE),
    gitSsh: emptyGitSsh,
  });

  await expect(
    service.run("/workspace/project", {
      excludes: [],
      includes: [],
      transport: new PublicTransport(),
      timeoutMs: 3_600_000,
    }),
  ).rejects.toThrow("Restore failed: daytona npm EACCES output");
  expect(provider.sandbox.destroyed).toBe(true);
});

test("TeleportService ships SSH bundle, bundle excludes, and mirrored includes", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/external.txt": "external",
      "/opt/shared/file.txt": "shared",
    },
    bytes: {
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
  const gitSsh: SshCollector = {
    collect: () => ({
      dirs: ["$HOME/.ssh"],
      files: [
        { path: "$HOME/.ssh/id_git", content: "PRIVATE", mode: "600" },
        { path: "$HOME/.ssh/id_git.pub", content: "PUBLIC", mode: "644" },
        {
          path: "$HOME/.ssh/known_hosts",
          content: "github.com ssh-ed25519 AAA\n",
          mode: "644",
        },
        { path: "$HOME/.ssh/config", content: "CONFIG", mode: "600" },
      ],
    }),
  };
  const service = new TeleportService(provider, CLAUDE_CODE, {
    host,
    session: { latest: async () => session, byId: async () => session },
    secrets: { collect: async () => ({ envs: {}, files: [] }) },
    auth: {
      extract: async () => ({
        envs: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
        files: [],
      }),
    },
    version: { detect: async () => "2.1.160" },
    bootstrap: new BootstrapService(CLAUDE_CODE),
    gitSsh,
  });

  await service.run("/workspace/project", {
    excludes: ["node_modules", "dist"],
    includes: [
      "/home/local/external.txt",
      "/missing/path",
      "/opt/shared/file.txt",
    ],
    transport: new PublicTransport(),
    timeoutMs: 3_600_000,
  });

  expect(host.spawnPipeCalls[0]).toContain("--exclude 'node_modules'");
  expect(host.spawnPipeCalls[0]).toContain("--exclude 'dist'");
  expect(host.spawnPipeCalls[1]).toContain("-czf '/tmp/sandhop-include-0-");
  expect(host.spawnPipeCalls[1]).toContain("-C '/home/local' 'external.txt'");
  expect(provider.sandbox.execs[2]).toContain("tar -xzf");
  expect(provider.sandbox.execs[2]).toContain("-C '/home/user'");
  expect(host.spawnPipeCalls[2]).toContain("-czf '/tmp/sandhop-include-2-");
  expect(host.spawnPipeCalls[2]).toContain("-C '/opt/shared' 'file.txt'");
  expect(provider.sandbox.execs[3]).toContain("-C '/opt/shared'");
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/home/user/.ssh/id_git",
    data: "PRIVATE",
  });
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/home/user/.ssh/config",
    data: "CONFIG",
  });
  expect(provider.sandbox.execs[4]).toContain("mkdir -p '/home/user/.ssh'");
  expect(provider.sandbox.execs[4]).toContain("chmod 700 '/home/user/.ssh'");
  expect(provider.sandbox.execs[4]).toContain(
    "chmod '600' '/home/user/.ssh/id_git'",
  );
  expect(provider.sandbox.execs[4]).toContain(
    "chmod '644' '/home/user/.ssh/known_hosts'",
  );
});
