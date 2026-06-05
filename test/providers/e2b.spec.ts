import { expect, test, vi } from "vitest";
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
  const listItems: { sandboxId: string; startedAt: Date | string }[] = [];
  const sandbox = {
    sandboxId: "sbx-created",
    files: { write: filesWrite },
    commands: { run: commandsRun },
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

test("E2bSandboxProvider creates sandboxes, uploads octet-stream bytes and paths, runs commands, exposes HTTPS URLs, and destroys", async () => {
  e2bMocks.commandsRun.mockReset();
  e2bMocks.Template.exists.mockClear();
  e2bMocks.Template.build.mockClear();
  e2bMocks.commandsRun.mockResolvedValueOnce({
    exitCode: 0,
    stdout: "/home/e2b",
    stderr: "",
  });
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
  });
  expect(sandbox.home).toBe("/home/e2b");
  await sandbox.uploadFile("/tmp/a", new Uint8Array([1, 2]));
  await sandbox.uploadPath("/tmp/large", localPath);
  await expect(sandbox.exec("echo ok")).resolves.toEqual({
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  });
  await sandbox.exec("echo slow", { timeoutMs: 123000 });
  await sandbox.spawn("ttyd");
  await expect(sandbox.exposePort(7681)).resolves.toEqual({
    url: "https://sbx-created-7681.e2b.app",
  });
  await expect(provider.destroy("sbx-created")).resolves.toBe(true);

  expect(e2bMocks.Template.exists).toHaveBeenCalledWith("sandhop");
  expect(e2bMocks.Template.build).not.toHaveBeenCalled();
  expect(e2bMocks.Sandbox.create).toHaveBeenCalledWith("sandhop", {
    apiKey: "e2b-key",
    envs: { A: "1" },
    timeoutMs: 600000,
  });
  expect(e2bMocks.filesWrite).toHaveBeenCalledWith(
    "/tmp/a",
    new Uint8Array([1, 2]).buffer,
    {
      requestTimeoutMs: 600000,
      useOctetStream: true,
    },
  );
  expect(e2bMocks.filesWrite).toHaveBeenCalledWith(
    "/tmp/large",
    expect.any(Blob),
    {
      requestTimeoutMs: 3_600_000,
      useOctetStream: true,
    },
  );
  expect(e2bMocks.commandsRun).toHaveBeenCalledWith("ttyd", {
    background: true,
    timeoutMs: 0,
  });
  expect(e2bMocks.commandsRun).toHaveBeenCalledWith("echo slow", {
    timeoutMs: 123000,
    requestTimeoutMs: 123000,
  });
});

test("E2bSandboxProvider returns non-zero command exits as RunResult data", async () => {
  e2bMocks.commandsRun.mockReset();
  e2bMocks.commandsRun.mockResolvedValueOnce({
    exitCode: 0,
    stdout: "/home/e2b",
    stderr: "",
  });
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
  });

  await expect(sandbox.exec("false")).resolves.toEqual({
    exitCode: 42,
    stdout: "partial",
    stderr: "boom",
  });
});

test("E2bSandboxProvider kills a created sandbox when home lookup fails", async () => {
  e2bMocks.commandsRun.mockReset();
  e2bMocks.commandsRun.mockResolvedValueOnce({
    exitCode: 1,
    stdout: "",
    stderr: "home failed",
  });
  e2bMocks.Sandbox.kill.mockClear();
  const provider = new E2bSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );

  await expect(
    provider.create({
      envs: {},
      timeoutMs: 600000,
      ports: [7681],
    }),
  ).rejects.toThrow("Home lookup failed: home failed");

  expect(e2bMocks.Sandbox.kill).toHaveBeenCalledWith("sbx-created", {
    apiKey: "e2b-key",
  });
});

test("E2bSandboxProvider rejects empty home lookup output", async () => {
  e2bMocks.commandsRun.mockReset();
  e2bMocks.commandsRun.mockResolvedValueOnce({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
  e2bMocks.Sandbox.kill.mockClear();
  const provider = new E2bSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );

  await expect(
    provider.create({
      envs: {},
      timeoutMs: 600000,
      ports: [7681],
    }),
  ).rejects.toThrow("Home lookup returned empty path");

  expect(e2bMocks.Sandbox.kill).toHaveBeenCalledWith("sbx-created", {
    apiKey: "e2b-key",
  });
});

test("E2bSandboxProvider guards list startedAt values", async () => {
  const valid = new Date("2026-06-01T00:00:00Z");
  e2bMocks.listItems.splice(
    0,
    e2bMocks.listItems.length,
    { sandboxId: "valid", startedAt: valid },
    { sandboxId: "invalid-date", startedAt: new Date("not-a-date") },
    { sandboxId: "string-date", startedAt: "2026-06-01T00:00:00Z" },
  );
  const provider = new E2bSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );

  await expect(provider.list()).resolves.toEqual([
    { id: "valid", startedAt: valid },
    { id: "invalid-date", startedAt: new Date(0) },
    { id: "string-date", startedAt: new Date(0) },
  ]);

  expect(e2bMocks.Sandbox.list).toHaveBeenCalledWith({ apiKey: "e2b-key" });
});

test("E2bSandboxProvider reconnects after adapter destroy", async () => {
  e2bMocks.commandsRun.mockReset();
  e2bMocks.commandsRun.mockResolvedValue({
    exitCode: 0,
    stdout: "/home/e2b",
    stderr: "",
  });
  e2bMocks.Sandbox.connect.mockClear();
  const provider = new E2bSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );
  const sandbox = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [7681],
  });

  await sandbox.destroy();
  await provider.connect("sbx-created");

  expect(e2bMocks.Sandbox.connect).toHaveBeenCalledWith("sbx-created", {
    apiKey: "e2b-key",
  });
});
