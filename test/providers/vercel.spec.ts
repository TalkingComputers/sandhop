import { Buffer } from "node:buffer";
import { expect, test, vi } from "vitest";
import { remotePath } from "../../src/core/paths.js";
import { FakeHost } from "../fakes/host.js";

const RUNTIME = {
  home: "/home/local",
  username: "local",
  workdir: "/workspace/project",
};

const vercelMocks = vi.hoisted(() => {
  const stdout = vi.fn(async () => "stdout");
  const stderr = vi.fn(async () => "stderr");
  const runCommand = vi.fn(
    async (cmd: string | { cmd: string; args?: string[] }) => {
      if (
        typeof cmd !== "string" &&
        cmd.cmd === "bash" &&
        cmd.args?.[1]?.includes("SANDHOP_RUNTIME")
      )
        return {
          exitCode: 0,
          stdout: vi.fn(async () => "/home/local\nlocal\n/workspace/project\n"),
          stderr: vi.fn(async () => ""),
        };
      if (typeof cmd !== "string" && cmd.cmd === "bash")
        return {
          exitCode: 0,
          stdout: vi.fn(async () => ""),
          stderr: vi.fn(async () => ""),
        };
      return { exitCode: 5, stdout, stderr };
    },
  );
  const mkDir = vi.fn(async () => undefined);
  const writeFiles = vi.fn(async () => undefined);
  const domain = vi.fn((port: number) => `https://vercel-${port}.example`);
  const stop = vi.fn(async () => undefined);
  const sandbox: {
    name: string;
    createdAt: Date | string;
    tags: Record<string, string>;
    runCommand: typeof runCommand;
    mkDir: typeof mkDir;
    writeFiles: typeof writeFiles;
    domain: typeof domain;
    stop: typeof stop;
  } = {
    name: "sdk-name",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    tags: {
      "sandhop.runtime.home": "/home/local",
      "sandhop.runtime.user": "local",
      "sandhop.runtime.workdir": "/workspace/project",
    },
    runCommand,
    mkDir,
    writeFiles,
    domain,
    stop,
  };
  const create = vi.fn(async () => sandbox);
  const get = vi.fn(async () => sandbox);
  const list = vi.fn(async () => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<typeof sandbox> {
      yield sandbox;
    },
  }));
  const Sandbox = { create, get, list };
  return {
    Sandbox,
    create,
    domain,
    get,
    list,
    mkDir,
    runCommand,
    stderr,
    stop,
    stdout,
    sandbox,
    writeFiles,
  };
});

const env = {
  VERCEL_TOKEN: "token",
  VERCEL_TEAM_ID: "team",
  VERCEL_PROJECT_ID: "project",
};

const VERCEL_NODE_MAJORS = [22, 24, 26] as const;
type VercelNodeRuntime = `node${(typeof VERCEL_NODE_MAJORS)[number]}`;

const vercelRuntime = (): VercelNodeRuntime => {
  const major = Number(process.versions.node.split(".", 1)[0]);
  if (!Number.isInteger(major))
    throw new Error(`Invalid Node version ${process.versions.node}`);
  if (
    !VERCEL_NODE_MAJORS.includes(major as (typeof VERCEL_NODE_MAJORS)[number])
  )
    throw new Error(`Vercel Sandbox does not support Node ${major}`);
  return `node${major as (typeof VERCEL_NODE_MAJORS)[number]}`;
};

const VERCEL_RUNTIME = vercelRuntime();
const TOOL_INSTALL =
  'ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) TTYD_ARCH=aarch64; CF_ARCH=arm64;; *) TTYD_ARCH=x86_64; CF_ARCH=amd64;; esac && curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${TTYD_ARCH} -o /usr/local/bin/ttyd && chmod +x /usr/local/bin/ttyd && curl -fsSL https://github.com/cloudflare/cloudflared/releases/download/2026.5.2/cloudflared-linux-${CF_ARCH} -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared';

const loadProvider = async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vercelMocks.sandbox.createdAt = new Date("2026-06-01T00:00:00Z");
  vi.doMock("@vercel/sandbox", () => ({ Sandbox: vercelMocks.Sandbox }));
  return import("../../src/providers/vercel/index.js");
};

test("VercelSandboxProvider creates a named sandbox with creds and maps exec results", async () => {
  const { VercelSandboxProvider } = await loadProvider();
  const provider = new VercelSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );

  const sandbox = await provider.create({
    envs: { A: "1" },
    timeoutMs: 3_600_000,
    ports: [3000, 7681],
    runtime: RUNTIME,
  });
  expect(sandbox.home).toBe("/home/local");

  await expect(sandbox.exec("echo", ["ok"])).resolves.toEqual({
    exitCode: 5,
    stdout: "stdout",
    stderr: "stderr",
  });
  await sandbox.exec("echo", ["slow"], { timeoutMs: 123000 });
  expect(vercelMocks.create).toHaveBeenCalledWith({
    token: "token",
    teamId: "team",
    projectId: "project",
    env: {
      A: "1",
      HOME: "/home/local",
      SANDHOP_RUNTIME_HOME: "/home/local",
      SANDHOP_RUNTIME_USER: "local",
      SANDHOP_RUNTIME_WORKDIR: "/workspace/project",
    },
    name: expect.stringMatching(/^sandhop-/),
    persistent: false,
    timeout: 3_600_000,
    ports: [3000, 7681],
    resources: { vcpus: 2 },
    runtime: VERCEL_RUNTIME,
    tags: {
      "sandhop.runtime.home": "/home/local",
      "sandhop.runtime.user": "local",
      "sandhop.runtime.workdir": "/workspace/project",
    },
  });
  expect(sandbox.id).toBe(
    (vercelMocks.create.mock.calls[0]![0] as { name: string }).name,
  );
  expect(vercelMocks.runCommand).toHaveBeenNthCalledWith(1, {
    cmd: "bash",
    args: [
      "-lc",
      `dnf install -y ca-certificates curl git zstd tmux util-linux shadow-utils && mkdir -p /home/local /workspace/project && useradd --user-group --create-home --home-dir /home/local --shell /bin/bash local && chown -R local\\:local /home/local /workspace/project && ${TOOL_INSTALL}`,
    ],
    sudo: true,
    timeoutMs: 3_600_000,
  });
  expect(vercelMocks.runCommand).toHaveBeenCalledWith({
    cmd: "env",
    args: [
      "HOME=/home/local",
      "SANDHOP_RUNTIME_HOME=/home/local",
      "SANDHOP_RUNTIME_USER=local",
      "SANDHOP_RUNTIME_WORKDIR=/workspace/project",
      "echo",
      "ok",
    ],
    cwd: "/workspace/project",
    sudo: true,
    timeoutMs: 600000,
  });
  expect(vercelMocks.runCommand).toHaveBeenCalledWith({
    cmd: "env",
    args: [
      "HOME=/home/local",
      "SANDHOP_RUNTIME_HOME=/home/local",
      "SANDHOP_RUNTIME_USER=local",
      "SANDHOP_RUNTIME_WORKDIR=/workspace/project",
      "echo",
      "slow",
    ],
    cwd: "/workspace/project",
    sudo: true,
    timeoutMs: 123000,
  });
  expect(vercelMocks.stdout).toHaveBeenCalled();
  expect(vercelMocks.stderr).toHaveBeenCalled();
});

test("VercelSandboxProvider spawn uses runtime runuser and upload stages files", async () => {
  const { VercelSandboxProvider } = await loadProvider();
  const provider = new VercelSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env,
      bytes: { "/local/profile.tgz": new Uint8Array([9, 8]) },
    }),
  );
  const sandbox = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [7681],
    runtime: RUNTIME,
  });

  await sandbox.spawn("ttyd", []);
  await sandbox.uploadFile(remotePath("/tmp/nested/a.txt"), "hello");
  await sandbox.uploadFile(remotePath("/tmp/b.bin"), new Uint8Array([1, 2]));
  await sandbox.uploadPath(
    remotePath("/tmp/profile.tgz"),
    "/local/profile.tgz",
  );
  await expect(sandbox.exposePort(7681)).resolves.toEqual({
    url: "https://vercel-7681.example",
  });
  await sandbox.destroy();

  expect(vercelMocks.runCommand).toHaveBeenCalledWith({
    cmd: "runuser",
    args: expect.arrayContaining(["-u", "local"]),
    detached: true,
    sudo: true,
    timeoutMs: 0,
  });
  expect(vercelMocks.mkDir).not.toHaveBeenCalled();
  expect(vercelMocks.writeFiles).toHaveBeenCalledWith([
    {
      path: expect.stringMatching(/^\/tmp\/sandhop-upload-/),
      content: Buffer.from("hello"),
    },
  ]);
  expect(vercelMocks.writeFiles).toHaveBeenCalledWith([
    {
      path: expect.stringMatching(/^\/tmp\/sandhop-upload-/),
      content: Buffer.from(new Uint8Array([1, 2])),
    },
  ]);
  expect(vercelMocks.writeFiles).toHaveBeenCalledWith([
    {
      path: expect.stringMatching(/^\/tmp\/sandhop-upload-/),
      content: Buffer.from(new Uint8Array([9, 8])),
    },
  ]);
  expect(vercelMocks.domain).toHaveBeenCalledWith(7681);
  expect(vercelMocks.stop).toHaveBeenCalled();
});

test("VercelSandboxProvider rejects invalid runtime before sandbox create", async () => {
  const { VercelSandboxProvider } = await loadProvider();
  vercelMocks.create.mockClear();
  const provider = new VercelSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );

  await expect(
    provider.create({
      envs: {},
      timeoutMs: 600000,
      ports: [7681],
      runtime: { home: "/home/local", username: "root", workdir: "/work" },
    }),
  ).rejects.toThrow(
    "Sandbox runtime username must be a non-root Linux username: root",
  );

  expect(vercelMocks.create).not.toHaveBeenCalled();
});

test("VercelSandboxProvider connects and destroys by SDK lookup", async () => {
  const { VercelSandboxProvider } = await loadProvider();
  const provider = new VercelSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );

  const created = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [7681],
    runtime: RUNTIME,
  });
  const connectedCreated = await provider.connect(created.id);

  const connected = await provider.connect("sandhop-existing");
  await expect(provider.destroy(created.id)).resolves.toBe(true);

  expect(connectedCreated).not.toBe(created);
  expect(connectedCreated.home).toBe("/home/local");
  expect(connected.id).toBe("sandhop-existing");
  expect(connected.home).toBe("/home/local");
  expect(vercelMocks.get).toHaveBeenNthCalledWith(1, {
    token: "token",
    teamId: "team",
    projectId: "project",
    name: created.id,
    resume: true,
  });
  expect(vercelMocks.get).toHaveBeenNthCalledWith(2, {
    token: "token",
    teamId: "team",
    projectId: "project",
    name: "sandhop-existing",
    resume: true,
  });
  expect(vercelMocks.get).toHaveBeenNthCalledWith(3, {
    token: "token",
    teamId: "team",
    projectId: "project",
    name: created.id,
  });
  expect(vercelMocks.stop).toHaveBeenCalledTimes(1);
});

test("VercelSandboxProvider lists and destroys sandboxes by name", async () => {
  const { VercelSandboxProvider } = await loadProvider();
  const provider = new VercelSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );

  await expect(provider.list()).resolves.toEqual([
    { id: "sdk-name", startedAt: new Date("2026-06-01T00:00:00Z") },
  ]);
  await expect(provider.destroy("sandhop-existing")).resolves.toBe(true);

  expect(vercelMocks.list).toHaveBeenCalledWith({
    token: "token",
    teamId: "team",
    projectId: "project",
  });
  expect(vercelMocks.get).toHaveBeenCalledWith({
    token: "token",
    teamId: "team",
    projectId: "project",
    name: "sandhop-existing",
  });
  expect(vercelMocks.stop).toHaveBeenCalled();
});

test("VercelSandboxProvider rejects invalid createdAt", async () => {
  const { VercelSandboxProvider } = await loadProvider();
  vercelMocks.sandbox.createdAt = "not-a-date";
  const provider = new VercelSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );

  await expect(provider.list()).rejects.toThrow(
    "Invalid Vercel sandbox createdAt: sdk-name",
  );
});

test("VercelSandboxProvider destroy returns false when sandbox is missing", async () => {
  const { VercelSandboxProvider } = await loadProvider();
  const provider = new VercelSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );
  vercelMocks.get.mockRejectedValueOnce(
    Object.assign(new Error("not found"), { statusCode: 404 }),
  );

  await expect(provider.destroy("missing")).resolves.toBe(false);

  expect(vercelMocks.get).toHaveBeenCalledWith({
    token: "token",
    teamId: "team",
    projectId: "project",
    name: "missing",
  });
  expect(vercelMocks.stop).not.toHaveBeenCalled();
});

test("VercelSandboxProvider missing package throws install hint", async () => {
  vi.resetModules();
  vi.doMock("@vercel/sandbox", () => {
    throw new Error("Cannot find package '@vercel/sandbox'");
  });
  const { VercelSandboxProvider } =
    await import("../../src/providers/vercel/index.js");
  const provider = new VercelSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );

  await expect(
    provider.create({
      envs: {},
      timeoutMs: 600000,
      ports: [7681],
      runtime: RUNTIME,
    }),
  ).rejects.toThrow(
    "The 'vercel' provider needs @vercel/sandbox. Run: npm i @vercel/sandbox",
  );
});

test("VercelSandboxProvider requires env credentials", async () => {
  const { VercelSandboxProvider } = await loadProvider();
  const keys = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"] as const;

  for (const key of keys) {
    const brokenEnv: Record<string, string | undefined> = { ...env };
    delete brokenEnv[key];
    const provider = new VercelSandboxProvider(
      new FakeHost({ home: "/home/local", env: brokenEnv }),
    );

    await expect(
      provider.create({
        envs: {},
        timeoutMs: 600000,
        ports: [7681],
        runtime: RUNTIME,
      }),
    ).rejects.toThrow(`${key} is required — set it or run \`sandhop setup\``);
  }
});
