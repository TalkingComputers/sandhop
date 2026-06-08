import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { CODEX } from "../../../src/agents/codex.js";
import { TTYD_PORT } from "../../../src/core/constants.js";
import type {
  Agent,
  AuthBundle,
  SessionRef,
} from "../../../src/core/ports/agent.js";
import type { Transport } from "../../../src/core/ports/transport.js";
import { BootstrapService } from "../../../src/core/services/bootstrap.js";
import type { SshCollector } from "../../../src/core/services/git-ssh.js";
import { TeleportService } from "../../../src/core/services/teleport.js";
import { PublicTransport } from "../../../src/transports/public.js";
import { FakeHost } from "../../fakes/host.js";
import { FakeProvider } from "../../fakes/provider.js";

const encoder = new TextEncoder();

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

test("TeleportService fans out collection, transfers one zstd bundle, and starts HTTPS ttyd with native resume", async () => {
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
    execValues: {
      "git config --global --get user.name": "Host User\n",
      "git config --global --get user.email": "host@example.com\n",
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
    bootstrap: createBootstrap(CLAUDE_CODE),
    gitSsh: emptyGitSsh,
    multiplexer: tmuxMultiplexer,
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
      runtime: {
        home: "/home/local",
        username: "host-user",
        workdir: "/workspace/project",
      },
    },
  ]);
  expect(provider.sandbox.pathUploads).toEqual([
    {
      remotePath: expect.stringMatching(
        /\/tmp\/sandhop-bundle-.+\.part\.000000$/,
      ),
      localPath: expect.stringMatching(
        new RegExp(`${tmpdir()}/sandhop-bundle-.+\\.part\\.000000$`),
      ),
    },
  ]);
  expect(host.tarCalls).toEqual([
    expect.objectContaining({
      cwd: "/workspace/project",
      entries: ["."],
      outPath: expect.stringMatching(
        new RegExp(`${tmpdir()}/sandhop-bundle-.+\\.tar\\.zst$`),
      ),
    }),
  ]);
  expect(provider.sandbox.execs[0]).toContain(
    "$SUDO mkdir -p /workspace/project",
  );
  expect(provider.sandbox.execs[0]).toContain(
    '$SUDO chown -R "$SANDHOP_OWNER" /workspace/project',
  );
  expect(provider.sandbox.execs[1]).toContain("zstd -t");
  expect(provider.sandbox.execs[1]).toContain("wc -c");
  expect(provider.sandbox.execs[1]).toContain("zstd -d --long=27 -c");
  expect(provider.sandbox.execs[1]).toContain("tar -xf - -C");
  expect(provider.sandbox.execs[1]).not.toContain("apt-get");
  expect(provider.sandbox.uploads.map((upload) => upload.path)).toEqual([
    "/tmp/transcript.jsonl",
  ]);
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/tmp/transcript.jsonl",
    data: encoder.encode("transcript"),
  });
  expect(provider.sandbox.execs[2]).toContain(
    "git config --global --add safe.directory /workspace/project",
  );
  expect(provider.sandbox.execs[2]).toContain(
    "git config --global user.name 'Host User'",
  );
  expect(provider.sandbox.execs[2]).toContain(
    "git config --global user.email host\\@example.com",
  );
  expect(provider.sandbox.execs[2].indexOf("safe.directory")).toBeLessThan(
    provider.sandbox.execs[2].indexOf("user.name"),
  );
  expect(provider.sandbox.execs[2]).not.toContain("tar -xzf /tmp/bundle.tgz");
  expect(provider.sandbox.spawns[0]).toContain(
    `ttyd -p ${TTYD_PORT} -W -c host-user\\:`,
  );
  expect(provider.sandbox.spawns[0]).toContain("-c host-user\\:");
  expect(provider.sandbox.spawns[0]).not.toContain("-i 127.0.0.1");
  expect(provider.sandbox.spawns[0]).toContain(
    "tmux new -A -s sandhop bash -lc",
  );
  expect(provider.sandbox.spawns[0]).toContain("claude --resume");
  expect(provider.sandbox.spawns[0]).toContain(
    "cd /workspace/project && claude --resume session-id",
  );
  expect(provider.sandbox.spawns[0]).not.toContain("MCP_TIMEOUT=");
  expect(provider.sandbox.spawns[0]).not.toContain("for f in");
  expect(provider.sandbox.spawns[0]).toContain(
    ">> /tmp/sandhop-terminal.log 2>&1",
  );
  expect(provider.sandbox.execs[3]).toContain("pgrep -f");
  expect(provider.sandbox.execs[3]).toContain("/tmp/sandhop-terminal.log");
  expect(provider.sandbox.execs).toHaveLength(4);
  expect(provider.sandbox.execs[2]).not.toContain("profile");
  expect(provider.sandbox.execs[2]).not.toContain("mcp");
  expect(provider.sandbox.exposedPorts).toEqual([TTYD_PORT]);
  expect(result.sandbox).toBe(provider.sandbox);
  expect(result.url).toBe(`https://sandbox-sbx-1-${TTYD_PORT}.example`);
  expect(result.user).toBe("host-user");
  expect(result.pass).toMatch(/^[A-Za-z0-9_-]{24}$/);
});

test("TeleportService transfers Claude project memory after the bundle when present", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude/projects/-workspace-project/memory/MEMORY.md":
        "memory",
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
    bootstrap: createBootstrap(CLAUDE_CODE),
    gitSsh: emptyGitSsh,
    multiplexer: tmuxMultiplexer,
  });

  await service.run("/workspace/project", {
    excludes: ["node_modules"],
    includes: [],
    transport: new PublicTransport(),
    timeoutMs: 3_600_000,
  });

  expect(host.tarCalls).toHaveLength(2);
  expect(host.tarCalls[0]!.outPath).toContain("sandhop-bundle-");
  expect(host.tarCalls[1]!.outPath).toContain("sandhop-memory-");
  expect(host.tarCalls[1]).toEqual(
    expect.objectContaining({
      cwd: "/home/local/.claude/projects/-workspace-project/memory",
      entries: ["."],
      excludes: ["node_modules"],
    }),
  );
  expect(provider.sandbox.execs[2]).toContain("sandhop-memory-");
  expect(provider.sandbox.execs[2]).toContain("zstd -d --long=27 -c");
  expect(provider.sandbox.execs[2]).toContain("tar -xf - -C");
  expect(provider.sandbox.execs[2]).toContain(
    "/home/user/.claude/projects/-workspace-project/memory",
  );
});

test("TeleportService uploads Claude transcript before the triggering sandhop command", async () => {
  const beforeSandhop = [
    '{"type":"user","message":{"role":"user","content":"fix this"},"uuid":"u1"}',
    '{"type":"assistant","message":{"role":"assistant","content":"ok"},"uuid":"a1"}',
  ].join("\n");
  const transcript = `${beforeSandhop}\n${[
    '{"type":"user","message":{"role":"user","content":"<command-message>sandhop</command-message>\\n<command-name>/sandhop</command-name>"},"uuid":"u2"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash"}]},"uuid":"a2"}',
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"SANDHOP_URL https://example"}]},"uuid":"u3"}',
  ].join("\n")}\n`;
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    bytes: {
      "/home/local/.claude/projects/-workspace-project/session-id.jsonl":
        encoder.encode(transcript),
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
    secrets: { collect: async () => ({ envs: {}, files: [] }) },
    auth: {
      extract: async () => ({
        envs: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
        files: [],
      }),
    },
    version: { detect: async () => "2.1.160" },
    bootstrap: createBootstrap(CLAUDE_CODE),
    gitSsh: emptyGitSsh,
    multiplexer: tmuxMultiplexer,
  });

  await service.run("/workspace/project", {
    excludes: [],
    includes: [],
    transport: new PublicTransport(),
    timeoutMs: 3_600_000,
  });

  expect(provider.sandbox.uploads).toContainEqual({
    path: "/tmp/transcript.jsonl",
    data: encoder.encode(`${beforeSandhop}\n`),
  });
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
    bootstrap: createBootstrap(CLAUDE_CODE),
    gitSsh: emptyGitSsh,
    multiplexer: tmuxMultiplexer,
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
    `ttyd -i 127.0.0.1 -p ${TTYD_PORT} -W -c host-user\\:`,
  );
  expect(provider.sandbox.spawns[0]).toContain(
    "tmux new -A -s sandhop bash -lc",
  );
  expect(provider.sandbox.spawns[0]).toContain(
    "MCP_TIMEOUT=120000 claude --resume",
  );
  expect(provider.sandbox.exposedPorts).toEqual([]);
  expect(result.url).toBe("https://cloudflared-sbx-1");
});

test("TeleportService uploads secret and auth files without MCP code bundles", async () => {
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
        files: [
          {
            path: "$HOME/.claude/.credentials.json",
            content: '{"mcpOAuth":{}}',
            mode: "600",
          },
        ],
      }),
    },
    version: { detect: async () => "2.1.160" },
    bootstrap: createBootstrap(CLAUDE_CODE),
    gitSsh: emptyGitSsh,
    multiplexer: tmuxMultiplexer,
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
        new RegExp(`${tmpdir()}/sandhop-bundle-.+\\.part\\.000000$`),
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
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/home/user/.claude/.credentials.json",
    data: '{"mcpOAuth":{}}',
  });
  expect(provider.sandbox.execs).toEqual(
    expect.arrayContaining([
      expect.stringContaining("$SUDO mkdir -p /home/user/.env.d"),
      expect.stringContaining("$SUDO mkdir -p /home/user/.claude"),
      "chmod 600 /home/user/.claude/.credentials.json",
    ]),
  );
  expect(provider.sandbox.execs.join("\n")).not.toContain("mcp-code");
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
    bootstrap: createBootstrap(CLAUDE_CODE),
    gitSsh: emptyGitSsh,
    multiplexer: tmuxMultiplexer,
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
  const bootstrap = createBootstrap(CLAUDE_CODE);
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
    bootstrap,
    gitSsh,
    multiplexer: tmuxMultiplexer,
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

  expect(host.tarCalls[0]!.excludes).toEqual(["node_modules", "dist"]);
  expect(host.tarCalls[1]!.outPath).toContain(`${tmpdir()}/sandhop-include-0-`);
  expect(host.tarCalls[1]).toEqual(
    expect.objectContaining({
      cwd: "/home/local",
      entries: ["external.txt"],
      excludes: ["node_modules", "dist"],
    }),
  );
  expect(provider.sandbox.execs[2]).toBe(
    bootstrap.renderPathPrep("/home/user"),
  );
  expect(provider.sandbox.execs[3]).toContain("zstd -d --long=27 -c");
  expect(provider.sandbox.execs[3]).toContain("tar -xf - -C");
  expect(provider.sandbox.execs[3]).toContain("/home/user");
  expect(host.tarCalls[2]!.outPath).toContain(`${tmpdir()}/sandhop-include-2-`);
  expect(host.tarCalls[2]).toEqual(
    expect.objectContaining({
      cwd: "/opt/shared",
      entries: ["file.txt"],
      excludes: ["node_modules", "dist"],
    }),
  );
  expect(provider.sandbox.execs[4]).toBe(
    bootstrap.renderPathPrep("/opt/shared"),
  );
  expect(provider.sandbox.execs[5]).toContain("/opt/shared");
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/home/user/.ssh/id_git",
    data: "PRIVATE",
  });
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/home/user/.ssh/config",
    data: "CONFIG",
  });
  const sshExecLog = provider.sandbox.execs.join("\n");
  expect(sshExecLog).toContain("mkdir -p /home/user/.ssh");
  expect(sshExecLog).toContain("chmod 700 /home/user/.ssh");
  expect(sshExecLog).toContain("chmod 600 /home/user/.ssh/id_git");
  expect(sshExecLog).toContain("chmod 644 /home/user/.ssh/known_hosts");
});

test("TeleportService wraps Codex resume in the shared tmux ttyd session", async () => {
  const transcript = [
    '{"type":"user","message":{"role":"user","content":"<command-name>/sandhop</command-name>"}}',
    '{"type":"assistant","message":{"role":"assistant","content":"done"}}',
  ].join("\n");
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    bytes: {
      "/home/local/.codex/sessions/2026/06/05/rollout-2026-06-05T00-00-00-session-id.jsonl":
        encoder.encode(transcript),
    },
  });
  const provider = new FakeProvider();
  const session: SessionRef = {
    sessionId: "session-id",
    transcriptPath:
      "/home/local/.codex/sessions/2026/06/05/rollout-2026-06-05T00-00-00-session-id.jsonl",
    transcriptName: "rollout-2026-06-05T00-00-00-session-id.jsonl",
  };
  const service = new TeleportService(provider, CODEX, {
    host,
    session: { latest: async () => session, byId: async () => session },
    secrets: { collect: async () => ({ envs: {}, files: [] }) },
    auth: {
      extract: async () => ({
        envs: { OPENAI_API_KEY: "sk-test" },
        files: [
          {
            path: "$HOME/.codex/auth.json",
            content: "{}",
            mode: "600",
          },
        ],
      }),
    },
    version: { detect: async () => "0.136.0" },
    bootstrap: createBootstrap(CODEX),
    gitSsh: emptyGitSsh,
    multiplexer: tmuxMultiplexer,
  });

  await service.run("/workspace/project", {
    excludes: [],
    includes: [],
    transport: new PublicTransport(),
    timeoutMs: 3_600_000,
  });

  expect(provider.sandbox.spawns[0]).toContain(
    "tmux new -A -s sandhop bash -lc",
  );
  expect(provider.sandbox.spawns[0]).toContain("codex resume");
  expect(provider.sandbox.execs).toEqual(
    expect.arrayContaining([
      expect.stringContaining("$SUDO mkdir -p /home/user/.codex"),
    ]),
  );
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/home/user/.codex/auth.json",
    data: "{}",
  });
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/tmp/transcript.jsonl",
    data: encoder.encode(transcript),
  });
});
