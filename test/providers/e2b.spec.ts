import { expect, test, vi } from "vitest";
import { remotePath } from "../../src/core/paths.js";
import { E2bSandboxProvider } from "../../src/providers/e2b/index.js";
import { FakeHost } from "../fakes/host.js";

const e2bMocks = vi.hoisted(() => {
  class CommandExitError extends Error {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;

    constructor(result: { exitCode: number; stdout: string; stderr: string }) {
      super(`Command exited with code ${result.exitCode}`);
      this.name = "CommandExitError";
      this.exitCode = result.exitCode;
      this.stdout = result.stdout;
      this.stderr = result.stderr;
    }
  }
  const filesWrite = vi.fn();
  const commandsRun = vi.fn();
  const getInfo = vi.fn(async () => ({
    metadata: {
      "sandhop.runtime.home": "/home/local",
      "sandhop.runtime.user": "local",
      "sandhop.runtime.workdir": "/workspace/project",
    },
  }));
  const listItems: { sandboxId: string; startedAt: Date | string }[] = [];
  const sandbox = {
    sandboxId: "sbx-created",
    files: { write: filesWrite },
    commands: { run: commandsRun },
    getInfo,
    getHost: vi.fn((port: number) => `sbx-created-${port}.e2b.app`),
  };
  const Sandbox = {
    create: vi.fn(async () => sandbox),
    connect: vi.fn(async () => sandbox),
    list: vi.fn(() => {
      let hasNext = listItems.length > 0;
      return {
        get hasNext(): boolean {
          return hasNext;
        },
        nextItems: vi.fn(async () => {
          hasNext = false;
          return listItems;
        }),
      };
    }),
    kill: vi.fn(async (id: string) => id === "sbx-created"),
  };
  const Template = Object.assign(vi.fn(), {
    exists: vi.fn(async () => true),
    build: vi.fn(),
  });
  return {
    CommandExitError,
    filesWrite,
    commandsRun,
    getInfo,
    listItems,
    sandbox,
    Sandbox,
    Template,
  };
});

vi.mock("e2b", () => ({
  CommandExitError: e2bMocks.CommandExitError,
  Sandbox: e2bMocks.Sandbox,
  Template: e2bMocks.Template,
}));

const env = { E2B_API_KEY: "e2b-key" };
const RUNTIME = {
  home: "/home/local",
  username: "local",
  workdir: "/workspace/project",
};

test("E2bSandboxProvider creates sandboxes, uploads octet-stream bytes and paths, runs commands, exposes HTTPS URLs, and destroys", async () => {
  e2bMocks.commandsRun.mockReset();
  e2bMocks.Template.exists.mockClear();
  e2bMocks.Template.build.mockClear();
  e2bMocks.commandsRun.mockResolvedValue({
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  });
  const localPath = "/tmp/sandhop-e2b.txt";
  const host = new FakeHost({
    home: "/home/local",
    env,
    files: { [localPath]: "large" },
  });
  const provider = new E2bSandboxProvider(host);

  const sandbox = await provider.create({
    envs: { A: "1" },
    timeoutMs: 600000,
    ports: [7681],
    runtime: RUNTIME,
  });
  expect(sandbox.home).toBe("/home/local");
  await sandbox.uploadFile(remotePath("/tmp/a"), new Uint8Array([1, 2]));
  await sandbox.uploadPath(remotePath("/tmp/large"), localPath);
  await expect(sandbox.exec("echo", ["ok"])).resolves.toEqual({
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  });
  await sandbox.exec("echo", ["slow"], { timeoutMs: 123000 });
  await sandbox.spawn("ttyd", []);
  await expect(sandbox.exposePort(7681)).resolves.toEqual({
    url: "https://sbx-created-7681.e2b.app",
  });
  await expect(provider.destroy("sbx-created")).resolves.toBe(true);

  expect(e2bMocks.Template.exists).toHaveBeenCalledWith(
    expect.stringMatching(/^sandhop-/),
    { apiKey: "e2b-key" },
  );
  expect(e2bMocks.Template.build).not.toHaveBeenCalled();
  expect(e2bMocks.Sandbox.create).toHaveBeenCalledWith(
    expect.stringMatching(/^sandhop-/),
    {
      apiKey: "e2b-key",
      envs: {
        A: "1",
        HOME: "/home/local",
        SANDHOP_RUNTIME_HOME: "/home/local",
        SANDHOP_RUNTIME_USER: "local",
        SANDHOP_RUNTIME_WORKDIR: "/workspace/project",
      },
      metadata: {
        "sandhop.runtime.home": "/home/local",
        "sandhop.runtime.user": "local",
        "sandhop.runtime.workdir": "/workspace/project",
      },
      timeoutMs: 600000,
    },
  );
  expect(e2bMocks.filesWrite).toHaveBeenCalledWith(
    "/tmp/a",
    new Uint8Array([1, 2]).buffer,
    {
      requestTimeoutMs: 600000,
      user: "local",
      useOctetStream: true,
    },
  );
  expect(e2bMocks.filesWrite).toHaveBeenCalledWith(
    "/tmp/large",
    expect.any(Blob),
    {
      requestTimeoutMs: 3_600_000,
      user: "local",
      useOctetStream: true,
    },
  );
  expect(e2bMocks.commandsRun).toHaveBeenCalledWith("ttyd", {
    background: true,
    cwd: "/workspace/project",
    envs: {
      HOME: "/home/local",
      SANDHOP_RUNTIME_HOME: "/home/local",
      SANDHOP_RUNTIME_USER: "local",
      SANDHOP_RUNTIME_WORKDIR: "/workspace/project",
    },
    timeoutMs: 0,
    user: "local",
  });
  expect(e2bMocks.commandsRun).toHaveBeenCalledWith("echo slow", {
    cwd: "/workspace/project",
    envs: {
      HOME: "/home/local",
      SANDHOP_RUNTIME_HOME: "/home/local",
      SANDHOP_RUNTIME_USER: "local",
      SANDHOP_RUNTIME_WORKDIR: "/workspace/project",
    },
    user: "root",
    timeoutMs: 123000,
    requestTimeoutMs: 123000,
  });
});

test("E2bSandboxProvider returns non-zero command exits as RunResult data", async () => {
  e2bMocks.commandsRun.mockReset();
  e2bMocks.commandsRun.mockRejectedValueOnce(
    new e2bMocks.CommandExitError({
      exitCode: 42,
      stdout: "partial",
      stderr: "boom",
    }),
  );
  const provider = new E2bSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );
  const sandbox = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [7681],
    runtime: RUNTIME,
  });

  await expect(sandbox.exec("false", [])).resolves.toEqual({
    exitCode: 42,
    stdout: "partial",
    stderr: "boom",
  });
});

test("E2bSandboxProvider rejects invalid runtime before sandbox create", async () => {
  e2bMocks.Sandbox.create.mockClear();
  const provider = new E2bSandboxProvider(
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

  expect(e2bMocks.Sandbox.create).not.toHaveBeenCalled();
});

test("E2bSandboxProvider rejects invalid runtime paths before sandbox create", async () => {
  e2bMocks.commandsRun.mockReset();
  e2bMocks.Sandbox.create.mockClear();
  const provider = new E2bSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );

  await expect(
    provider.create({
      envs: {},
      timeoutMs: 600000,
      ports: [7681],
      runtime: { home: "relative", username: "local", workdir: "/work" },
    }),
  ).rejects.toThrow("Sandbox runtime home must be an absolute path: relative");

  expect(e2bMocks.Sandbox.create).not.toHaveBeenCalled();
});

test("E2bSandboxProvider lists valid startedAt values", async () => {
  const valid = new Date("2026-06-01T00:00:00Z");
  e2bMocks.listItems.splice(
    0,
    e2bMocks.listItems.length,
    { sandboxId: "valid", startedAt: valid },
    { sandboxId: "string-date", startedAt: "2026-06-01T00:00:00Z" },
  );
  const provider = new E2bSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );

  await expect(provider.list()).resolves.toEqual([
    { id: "valid", startedAt: valid },
    { id: "string-date", startedAt: valid },
  ]);

  expect(e2bMocks.Sandbox.list).toHaveBeenCalledWith({ apiKey: "e2b-key" });
});

test("E2bSandboxProvider rejects invalid list startedAt values", async () => {
  e2bMocks.listItems.splice(0, e2bMocks.listItems.length, {
    sandboxId: "invalid-date",
    startedAt: new Date("not-a-date"),
  });
  const provider = new E2bSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );

  await expect(provider.list()).rejects.toThrow(
    "Invalid E2B sandbox startedAt: invalid-date",
  );
});

test("E2bSandboxProvider reconnects after adapter destroy", async () => {
  e2bMocks.commandsRun.mockReset();
  e2bMocks.commandsRun.mockResolvedValue({
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  });
  e2bMocks.getInfo.mockClear();
  e2bMocks.Sandbox.connect.mockClear();
  const provider = new E2bSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );
  const sandbox = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [7681],
    runtime: RUNTIME,
  });
  await sandbox.destroy();
  await provider.connect("sbx-created");

  expect(e2bMocks.Sandbox.connect).toHaveBeenCalledWith("sbx-created", {
    apiKey: "e2b-key",
  });
  expect(e2bMocks.getInfo).toHaveBeenCalled();
});
