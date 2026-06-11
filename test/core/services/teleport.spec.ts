import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { CODEX } from "../../../src/agents/codex.js";
import { TTYD_PORT } from "../../../src/core/constants.js";
import type { AuthBundle, SessionRef } from "../../../src/core/ports/agent.js";
import type { CommandInvocation } from "../../../src/core/ports/provider.js";
import type { Transport } from "../../../src/core/ports/transport.js";
import type { SshCollector } from "../../../src/core/services/git-ssh.js";
import { renderPathPrep } from "../../../src/core/services/sandbox-files.js";
import { TeleportService } from "../../../src/core/services/teleport.js";
import { PublicTransport } from "../../../src/transports/public.js";
import { FakeHost } from "../../fakes/host.js";
import { FakeProvider } from "../../fakes/provider.js";

const encoder = new TextEncoder();

const tmuxMultiplexer = {
  id: "tmux",
  install: (): string[] => [
    "bash -lc 'DEBIAN_FRONTEND=noninteractive apt-get install -y tmux'",
    `printf '%s\\n' 'set -g status off' 'set -g window-size latest' 'set -g focus-events on' 'set -g mouse on' 'set -g history-limit 10000' > "$HOME/.tmux.conf"`,
  ],
  attach: (session: string, command: CommandInvocation): CommandInvocation => ({
    file: "tmux",
    args: ["-u", "new", "-A", "-s", session, command.file, ...command.args],
  }),
};

class RealpathHost extends FakeHost {
  realpaths: string[] = [];

  realpath(path: string): string {
    this.realpaths.push(path);
    return path;
  }
}

const emptyGitSsh: SshCollector = {
  collect: () => ({ files: [], dirs: [], hosts: [] }),
};

const findExec = (execs: string[], needle: string): string => {
  const exec = execs.find((candidate) => candidate.includes(needle));
  if (exec === undefined) throw new Error(`exec containing ${needle} missing`);
  return exec;
};

const createBasicTeleport = (): {
  provider: FakeProvider;
  service: TeleportService;
} => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: { "/workspace/project/README.md": "" },
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
  return {
    provider,
    service: new TeleportService(provider, CLAUDE_CODE, {
      host,
      session,
      secrets: {
        collect: () => ({ envs: {}, files: [] }),
      },
      auth: () => ({ envs: { ANTHROPIC_API_KEY: "sk-ant" }, files: [] }),
      version: () => "2.1.160",
      gitSsh: emptyGitSsh,
      multiplexer: tmuxMultiplexer,
    }),
  };
};

test("TeleportService collects, transfers one zstd bundle, and starts HTTPS ttyd with native resume", async () => {
  const host = new RealpathHost({
    home: "/home/local",
    env: {},
    files: { "/workspace/project/README.md": "" },
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
    session,
    secrets: {
      collect: () => ({ envs: { MCP_TOKEN: "mcp-token" }, files: [] }),
    },
    auth: () => auth,
    version: () => "2.1.160",
    gitSsh: emptyGitSsh,
    multiplexer: tmuxMultiplexer,
  });

  const result = await service.run("/workspace/project", {
    excludes: [],
    includes: [],
    transport: new PublicTransport(),
    timeoutMs: 3_600_000,
  });

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
      agentInstall: expect.stringContaining(
        "curl -fsSL https://claude.ai/install.sh | bash -s 2.1.160",
      ),
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
  expect(provider.sandbox.execs[0]).toContain("mkdir -p /workspace/project");
  expect(provider.sandbox.execs[0]).toContain(
    'chown -R "$SANDHOP_OWNER" /workspace/project',
  );
  const extractExec = findExec(provider.sandbox.execs, "zstd -t");
  expect(extractExec).toContain("wc -c");
  expect(extractExec).toContain("zstd -d --long=27 -c");
  expect(extractExec).toContain("tar -xf - -C");
  expect(extractExec).not.toContain("apt-get");
  expect(provider.sandbox.uploads.map((upload) => upload.path)).toEqual([
    "/tmp/transcript.jsonl",
    expect.stringMatching(/^\/tmp\/sandhop-claude-preseed-[0-9a-f]{16}\.js$/),
    "/tmp/sandhop-terminal-proxy.cjs",
    "/tmp/sandhop-terminal.html",
  ]);
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/tmp/transcript.jsonl",
    data: encoder.encode("transcript"),
  });
  expect(provider.sandbox.uploads).toContainEqual({
    path: expect.stringMatching(
      /^\/tmp\/sandhop-claude-preseed-[0-9a-f]{16}\.js$/,
    ),
    data: expect.stringContaining("hasCompletedOnboarding"),
  });
  const restoreExec = findExec(provider.sandbox.execs, "SANDHOP_RESTORE_OK");
  expect(restoreExec).toContain(
    "git config --global --add safe.directory /workspace/project",
  );
  expect(restoreExec).toContain("git config --global user.name 'Host User'");
  expect(restoreExec).toContain(
    "git config --global user.email host\\@example.com",
  );
  expect(restoreExec.indexOf("safe.directory")).toBeLessThan(
    restoreExec.indexOf("user.name"),
  );
  expect(restoreExec).not.toContain("tar -xzf /tmp/bundle.tgz");
  expect(provider.sandbox.services).toHaveLength(1);
  expect(provider.sandbox.services[0]!.file).toBe("bash");
  expect(provider.sandbox.services[0]!.args.join(" ")).toContain(
    "ttyd -i 127.0.0.1 -p 7682 -W -t disableLeaveAlert\\=true -t disableResizeOverlay\\=true -c host-user\\:",
  );
  expect(provider.sandbox.services[0]!.args.join(" ")).toContain(
    "exec node /tmp/sandhop-terminal-proxy.cjs",
  );
  expect(provider.sandbox.services[0]!.args.join(" ")).toContain(
    "tmux -u new -A -s sandhop bash -lc",
  );
  expect(provider.sandbox.services[0]!.args.join(" ")).toContain(
    "claude --resume",
  );
  expect(provider.sandbox.services[0]!.args.join(" ")).toContain(
    'cd /workspace/project && export PATH="$HOME/.local/bin:$PATH" && DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1 claude --resume session-id',
  );
  expect(provider.sandbox.services[0]!.args.join(" ")).not.toContain(
    "MCP_TIMEOUT=",
  );
  expect(provider.sandbox.services[0]!.args.join(" ")).not.toContain(
    "for f in",
  );
  expect(provider.sandbox.services[0]).toMatchObject({
    port: TTYD_PORT,
    readiness: {
      kind: "http",
      url: `http://127.0.0.1:${TTYD_PORT}`,
      status: 401,
      timeoutMs: 10000,
      intervalMs: 100,
    },
    stdoutPath: "/tmp/sandhop-terminal.log",
    stderrPath: "/tmp/sandhop-terminal.log",
    appendOutput: true,
  });
  expect(provider.sandbox.execs.join("\n")).not.toContain("pgrep");
  expect(provider.sandbox.execs).toHaveLength(7);
  expect(restoreExec).not.toContain("profile");
  expect(restoreExec).not.toContain("mcp");
  expect(provider.sandbox.exposedPorts).toEqual([TTYD_PORT]);
  expect(result.sandbox).toBe(provider.sandbox);
  expect(result.url).toBe(`https://sandbox-sbx-1-${TTYD_PORT}.example`);
  expect(result.user).toBe("host-user");
  expect(result.pass).toMatch(/^[A-Za-z0-9_-]{24}$/);
});

test("TeleportService runs preparation before terminal startup and exposure", async () => {
  const { provider, service } = createBasicTeleport();
  const observed: { services: number; exposedPorts: number; execs: number }[] =
    [];

  await service.run("/workspace/project", {
    excludes: [],
    includes: [],
    transport: new PublicTransport(),
    timeoutMs: 3_600_000,
    beforeTerminalStart: async (sandbox): Promise<void> => {
      observed.push({
        services: provider.sandbox.services.length,
        exposedPorts: provider.sandbox.exposedPorts.length,
        execs: provider.sandbox.execs.length,
      });
      await sandbox.exec("echo", ["enriched"]);
    },
  });

  expect(observed).toEqual([{ services: 0, exposedPorts: 0, execs: 5 }]);
  expect(provider.sandbox.execs[5]).toBe("echo enriched");
  expect(provider.sandbox.services).toHaveLength(1);
  expect(provider.sandbox.exposedPorts).toEqual([TTYD_PORT]);
});

test("TeleportService aborts before terminal startup when preparation fails", async () => {
  const { provider, service } = createBasicTeleport();

  await expect(
    service.run("/workspace/project", {
      excludes: [],
      includes: [],
      transport: new PublicTransport(),
      timeoutMs: 3_600_000,
      beforeTerminalStart: async (): Promise<void> => {
        throw new Error("enrichment failed");
      },
    }),
  ).rejects.toThrow("enrichment failed");

  expect(provider.sandbox.services).toEqual([]);
  expect(provider.sandbox.exposedPorts).toEqual([]);
  expect(provider.sandbox.destroyed).toBe(true);
});

test("TeleportService transfers Claude project memory after the bundle when present", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/workspace/project/README.md": "",
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
    session,
    secrets: { collect: () => ({ envs: {}, files: [] }) },
    auth: () => ({
      envs: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
      files: [],
    }),
    version: () => "2.1.160",
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
  const memoryExec = findExec(provider.sandbox.execs, "sandhop-memory-");
  expect(memoryExec).toContain("zstd -d --long=27 -c");
  expect(memoryExec).toContain("tar -xf - -C");
  expect(memoryExec).toContain(
    "/home/local/.claude/projects/-workspace-project/memory",
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
    files: { "/workspace/project/README.md": "" },
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
    session,
    secrets: { collect: () => ({ envs: {}, files: [] }) },
    auth: () => ({
      envs: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
      files: [],
    }),
    version: () => "2.1.160",
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
    files: { "/workspace/project/README.md": "" },
    bytes: {
      "/home/local/.claude/projects/-workspace-project/session-id.jsonl":
        encoder.encode("transcript"),
    },
  });
  const provider = new FakeProvider();
  const cloudflaredTransport: Transport = {
    id: "cloudflared",
    bindAddress: () => "127.0.0.1",
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
    session,
    secrets: { collect: () => ({ envs: {}, files: [] }) },
    auth: () => ({
      envs: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
      files: [],
    }),
    version: () => "2.1.160",
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
  expect(findExec(provider.sandbox.execs, "SANDHOP_RESTORE_OK")).toContain(
    "install cloudflared",
  );
  expect(provider.sandbox.services[0]!.args.join(" ")).toContain(
    "ttyd -i 127.0.0.1 -p 7682 -W -t disableLeaveAlert\\=true -t disableResizeOverlay\\=true -c host-user\\:",
  );
  const cloudflaredProxy = provider.sandbox.uploads.find(
    (upload) => upload.path === "/tmp/sandhop-terminal-proxy.cjs",
  );
  expect(cloudflaredProxy?.data).toContain(
    `server.listen(${TTYD_PORT}, "127.0.0.1")`,
  );
  expect(provider.sandbox.services[0]!.args.join(" ")).toContain(
    "tmux -u new -A -s sandhop bash -lc",
  );
  expect(provider.sandbox.services[0]!.args.join(" ")).toContain(
    "MCP_TIMEOUT=120000 claude --resume",
  );
  expect(provider.sandbox.exposedPorts).toEqual([]);
  expect(result.url).toBe("https://cloudflared-sbx-1");
});

test("TeleportService uploads secret and auth files without MCP code bundles", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: { "/workspace/project/README.md": "" },
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
    session,
    secrets: {
      collect: () => ({
        envs: { MCP_TOKEN: "token" },
        files: [
          {
            path: "$HOME/.config/sandhop/mcp.env",
            content: "MCP_TOKEN=token\n",
          },
        ],
      }),
    },
    auth: () => ({
      envs: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
      files: [
        {
          path: "$HOME/.claude/.credentials.json",
          content: '{"mcpOAuth":{}}',
          mode: "600",
        },
      ],
    }),
    version: () => "2.1.160",
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
    path: "/home/local/.config/sandhop/mcp.env",
    data: "MCP_TOKEN=token\n",
  });
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/home/local/.claude/.credentials.json",
    data: '{"mcpOAuth":{}}',
  });
  expect(provider.sandbox.execs).toEqual(
    expect.arrayContaining([
      expect.stringContaining("mkdir -p /home/local/.config/sandhop"),
      expect.stringContaining("mkdir -p /home/local/.claude"),
      expect.stringContaining(
        "chmod 600 /home/local/.claude/.credentials.json",
      ),
    ]),
  );
  expect(provider.sandbox.execs.join("\n")).not.toContain("mcp-code");
});

test("TeleportService restore failure surfaces stdout when stderr is empty", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: { "/workspace/project/README.md": "" },
    bytes: {
      "/home/local/.claude/projects/-workspace-project/session-id.jsonl":
        encoder.encode("transcript"),
    },
  });
  const provider = new FakeProvider();
  const baseExec = provider.sandbox.exec.bind(provider.sandbox);
  provider.sandbox.exec = async (file, args, opts) => {
    const result = await baseExec(file, args, opts);
    return args.some(
      (arg) => typeof arg === "string" && arg.includes("SANDHOP_RESTORE_OK"),
    )
      ? { exitCode: 1, stdout: "daytona npm EACCES output", stderr: "" }
      : result;
  };
  const session: SessionRef = {
    sessionId: "session-id",
    transcriptPath:
      "/home/local/.claude/projects/-workspace-project/session-id.jsonl",
    transcriptName: "session-id.jsonl",
  };
  const service = new TeleportService(provider, CLAUDE_CODE, {
    host,
    session,
    secrets: { collect: () => ({ envs: {}, files: [] }) },
    auth: () => ({
      envs: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
      files: [],
    }),
    version: () => "2.1.160",
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
      "/workspace/project/README.md": "",
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
      hosts: ["github.com"],
      dirs: [{ path: "$HOME/.ssh", mode: "700" }],
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
    session,
    secrets: { collect: () => ({ envs: {}, files: [] }) },
    auth: () => ({
      envs: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
      files: [],
    }),
    version: () => "2.1.160",
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
  const execs = provider.sandbox.execs;
  const homePrep = execs.indexOf(renderPathPrep("/home/local"));
  const sharedPrep = execs.indexOf(renderPathPrep("/opt/shared"));
  const homeExtract = execs.findIndex(
    (cmd) =>
      cmd.includes("zstd -d --long=27 -c") &&
      cmd.includes("sandhop-include-0-"),
  );
  const sharedExtract = execs.findIndex(
    (cmd) =>
      cmd.includes("zstd -d --long=27 -c") &&
      cmd.includes("sandhop-include-2-"),
  );
  expect(homePrep).toBeGreaterThan(-1);
  expect(sharedPrep).toBeGreaterThan(-1);
  expect(homeExtract).toBeGreaterThan(homePrep);
  expect(sharedExtract).toBeGreaterThan(sharedPrep);
  expect(execs[homeExtract]).toContain("tar -xf - -C");
  expect(execs[homeExtract]).toContain("/home/local");
  expect(execs[sharedExtract]).toContain("/opt/shared");
  expect(host.tarCalls[2]!.outPath).toContain(`${tmpdir()}/sandhop-include-2-`);
  expect(host.tarCalls[2]).toEqual(
    expect.objectContaining({
      cwd: "/opt/shared",
      entries: ["file.txt"],
      excludes: ["node_modules", "dist"],
    }),
  );
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/home/local/.ssh/id_git",
    data: "PRIVATE",
  });
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/home/local/.ssh/config",
    data: "CONFIG",
  });
  const sshExecLog = provider.sandbox.execs.join("\n");
  expect(sshExecLog).toContain("mkdir -p /home/local/.ssh");
  expect(sshExecLog).toContain("chmod 700 /home/local/.ssh");
  expect(sshExecLog).toContain("chmod 600 /home/local/.ssh/id_git");
  expect(sshExecLog).toContain("chmod 644 /home/local/.ssh/known_hosts");
});

test("TeleportService wraps Codex resume in the shared tmux ttyd session", async () => {
  const transcript = [
    '{"type":"user","message":{"role":"user","content":"<command-name>/sandhop</command-name>"}}',
    '{"type":"assistant","message":{"role":"assistant","content":"done"}}',
  ].join("\n");
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: { "/workspace/project/README.md": "" },
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
    session,
    secrets: { collect: () => ({ envs: {}, files: [] }) },
    auth: () => ({
      envs: { OPENAI_API_KEY: "sk-test" },
      files: [
        {
          path: "$HOME/.codex/auth.json",
          content: "{}",
          mode: "600",
        },
      ],
    }),
    version: () => "0.136.0",
    gitSsh: emptyGitSsh,
    multiplexer: tmuxMultiplexer,
  });

  await service.run("/workspace/project", {
    excludes: [],
    includes: [],
    transport: new PublicTransport(),
    timeoutMs: 3_600_000,
  });

  expect(provider.sandbox.services[0]!.args.join(" ")).toContain(
    "tmux -u new -A -s sandhop bash -lc",
  );
  expect(provider.sandbox.services[0]!.args.join(" ")).toContain(
    "codex resume",
  );
  expect(provider.sandbox.execs).toEqual(
    expect.arrayContaining([
      expect.stringContaining("mkdir -p /home/local/.codex"),
    ]),
  );
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/home/local/.codex/auth.json",
    data: "{}",
  });
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/tmp/transcript.jsonl",
    data: encoder.encode(transcript),
  });
});
