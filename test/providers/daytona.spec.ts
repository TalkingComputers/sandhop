import { Buffer } from "node:buffer";
import { expect, test, vi } from "vitest";
import { remotePath } from "../../src/core/paths.js";
import { FakeHost } from "../fakes/host.js";

const daytonaMocks = vi.hoisted(() => {
  const executeCommand = vi.fn(async () => ({
    exitCode: 0,
    result: "",
  }));
  const createSession = vi.fn(async () => undefined);
  const executeSessionCommand = vi.fn(
    async (sessionId: string, req: { command: string }) =>
      req.command === "bash -lc 'printf %s \"$HOME\"'"
        ? {
            exitCode: 0,
            stdout: "/home/daytona",
            stderr: "",
          }
        : req.command === "bash -lc 'echo ok'"
          ? {
              exitCode: 0,
              stdout: "ok\n",
              stderr: "",
            }
          : req.command === "bash -lc 'echo err'"
            ? {
                exitCode: 3,
                stdout: "out\n",
                stderr: "err\n",
              }
            : {
                exitCode: 0,
                stdout: "",
                stderr: "",
              },
  );
  const deleteSession = vi.fn(async () => undefined);
  const uploadFile = vi.fn(async () => undefined);
  const getPreviewLink = vi.fn(async () => ({
    url: "https://daytona-preview.example",
    token: "preview-token",
  }));
  const deleteSandbox = vi.fn(async () => undefined);
  const sandbox: {
    id: string;
    createdAt?: string;
    process: {
      createSession: typeof createSession;
      deleteSession: typeof deleteSession;
      executeCommand: typeof executeCommand;
      executeSessionCommand: typeof executeSessionCommand;
    };
    fs: { uploadFile: typeof uploadFile };
    getPreviewLink: typeof getPreviewLink;
    delete: typeof deleteSandbox;
  } = {
    id: "daytona-sbx",
    process: {
      createSession,
      deleteSession,
      executeCommand,
      executeSessionCommand,
    },
    fs: { uploadFile },
    getPreviewLink,
    delete: deleteSandbox,
  };
  const create = vi.fn(async () => sandbox);
  const get = vi.fn(async () => sandbox);
  const list = vi.fn(() => [sandbox]);
  const Daytona = vi.fn(() => ({ create, get, list }));
  return {
    Daytona,
    create,
    createSession,
    deleteSession,
    deleteSandbox,
    executeCommand,
    executeSessionCommand,
    get,
    getPreviewLink,
    list,
    sandbox,
    uploadFile,
  };
});

const loadProvider = async () => {
  vi.resetModules();
  vi.clearAllMocks();
  daytonaMocks.sandbox.createdAt = undefined;
  vi.doMock("@daytona/sdk", () => ({ Daytona: daytonaMocks.Daytona }));
  return import("../../src/providers/daytona/index.js");
};

test("DaytonaSandboxProvider creates a sandbox and maps session stdout and stderr", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  const host = new FakeHost({
    home: "/home/local",
    env: {
      DAYTONA_API_KEY: "api-key",
      DAYTONA_API_URL: "https://api.daytona.example",
      DAYTONA_TARGET: "target",
    },
  });
  const provider = new DaytonaSandboxProvider(host);

  const sandbox = await provider.create({
    envs: { A: "1" },
    timeoutMs: 600000,
    ports: [7681],
  });
  expect(sandbox.home).toBe("/home/daytona");

  await expect(sandbox.exec("echo", ["ok"])).resolves.toEqual({
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
  });
  await expect(sandbox.exec("echo", ["err"])).resolves.toEqual({
    exitCode: 3,
    stdout: "out\n",
    stderr: "err\n",
  });
  await sandbox.exec("echo", ["slow"], { timeoutMs: 123000 });
  expect(daytonaMocks.Daytona).toHaveBeenCalledWith({
    apiKey: "api-key",
    apiUrl: "https://api.daytona.example",
    target: "target",
  });
  expect(daytonaMocks.create).toHaveBeenCalledWith(
    {
      envVars: { A: "1" },
      autoStopInterval: 10,
      ephemeral: true,
    },
    { timeout: 600 },
  );
  expect(daytonaMocks.executeSessionCommand).toHaveBeenNthCalledWith(
    1,
    expect.stringMatching(/^sandhop-exec-/),
    {
      command: "bash -lc 'printf %s \"$HOME\"'",
      runAsync: false,
      suppressInputEcho: true,
    },
    600,
  );
  expect(daytonaMocks.executeSessionCommand).toHaveBeenNthCalledWith(
    2,
    expect.stringMatching(/^sandhop-exec-/),
    {
      command: "bash -lc 'apt-get update && apt-get install -y zstd'",
      runAsync: false,
      suppressInputEcho: true,
    },
    600,
  );
  expect(daytonaMocks.executeSessionCommand).toHaveBeenCalledWith(
    expect.stringMatching(/^sandhop-exec-/),
    {
      command: "bash -lc 'echo ok'",
      runAsync: false,
      suppressInputEcho: true,
    },
    600,
  );
  expect(daytonaMocks.executeSessionCommand).toHaveBeenCalledWith(
    expect.stringMatching(/^sandhop-exec-/),
    {
      command: "bash -lc 'echo slow'",
      runAsync: false,
      suppressInputEcho: true,
    },
    123,
  );
  expect(daytonaMocks.executeCommand).not.toHaveBeenCalledWith(
    "bash -lc 'printf %s \"$HOME\"'",
  );
});

test("DaytonaSandboxProvider deletes a created sandbox when home lookup fails", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  daytonaMocks.executeSessionCommand.mockResolvedValueOnce({
    exitCode: 1,
    stdout: "",
    stderr: "home failed",
  });
  const provider = new DaytonaSandboxProvider(
    new FakeHost({ home: "/home/local", env: { DAYTONA_API_KEY: "api-key" } }),
  );

  await expect(
    provider.create({
      envs: {},
      timeoutMs: 600000,
      ports: [7681],
    }),
  ).rejects.toThrow("Home lookup failed: home failed");

  expect(daytonaMocks.deleteSandbox).toHaveBeenCalledWith(600);
});

test("DaytonaSandboxProvider spawn backgrounds commands without a session", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  const provider = new DaytonaSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env: { DAYTONA_API_KEY: "api-key" },
    }),
  );
  const sandbox = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [7681],
  });
  daytonaMocks.executeCommand.mockClear();

  await sandbox.spawn("ttyd", []);
  await sandbox.spawn("cloudflared", []);

  expect(daytonaMocks.executeCommand).toHaveBeenNthCalledWith(
    1,
    "nohup bash -lc ttyd >/dev/null 2>&1 &",
    undefined,
    undefined,
    600,
  );
  expect(daytonaMocks.executeCommand).toHaveBeenNthCalledWith(
    2,
    "nohup bash -lc cloudflared >/dev/null 2>&1 &",
    undefined,
    undefined,
    600,
  );
});

test("DaytonaSandboxProvider uses fixed command timeout after long create", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  const provider = new DaytonaSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env: { DAYTONA_API_KEY: "api-key" },
    }),
  );
  const sandbox = await provider.create({
    envs: {},
    timeoutMs: 3_600_000,
    ports: [7681],
  });
  daytonaMocks.executeCommand.mockClear();
  daytonaMocks.executeSessionCommand.mockClear();

  await sandbox.exec("echo", ["ok"]);
  await sandbox.spawn("ttyd", []);

  expect(daytonaMocks.executeSessionCommand).toHaveBeenNthCalledWith(
    1,
    expect.stringMatching(/^sandhop-exec-/),
    {
      command: "bash -lc 'echo ok'",
      runAsync: false,
      suppressInputEcho: true,
    },
    600,
  );
  expect(daytonaMocks.executeCommand).toHaveBeenNthCalledWith(
    1,
    "nohup bash -lc ttyd >/dev/null 2>&1 &",
    undefined,
    undefined,
    600,
  );
});

test("DaytonaSandboxProvider maps missing and malformed createdAt to epoch", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  const provider = new DaytonaSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env: { DAYTONA_API_KEY: "api-key" },
    }),
  );

  await expect(provider.list()).resolves.toEqual([
    { id: "daytona-sbx", startedAt: new Date(0) },
  ]);

  daytonaMocks.sandbox.createdAt = "not-a-date";
  await expect(provider.list()).resolves.toEqual([
    { id: "daytona-sbx", startedAt: new Date(0) },
  ]);
});

test("DaytonaSandboxProvider uploads files, exposes ports, and destroys", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  const provider = new DaytonaSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env: { DAYTONA_API_KEY: "api-key" },
    }),
  );
  const sandbox = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [7681],
  });

  await sandbox.uploadFile(remotePath("/tmp/a"), "hello");
  await sandbox.uploadFile(remotePath("/tmp/b"), new Uint8Array([1, 2]));
  await sandbox.uploadPath(
    remotePath("/tmp/profile.tgz"),
    "/local/profile.tgz",
  );
  await expect(sandbox.exposePort(7681)).resolves.toEqual({
    url: "https://daytona-preview.example",
  });
  await sandbox.destroy();

  expect(daytonaMocks.uploadFile).toHaveBeenCalledWith(
    Buffer.from("hello"),
    "/tmp/a",
    600,
  );
  expect(daytonaMocks.uploadFile).toHaveBeenCalledWith(
    Buffer.from(new Uint8Array([1, 2])),
    "/tmp/b",
    600,
  );
  expect(daytonaMocks.uploadFile).toHaveBeenCalledWith(
    "/local/profile.tgz",
    "/tmp/profile.tgz",
    3600,
  );
  expect(daytonaMocks.getPreviewLink).toHaveBeenCalledWith(7681);
  expect(daytonaMocks.deleteSandbox).toHaveBeenCalledWith(600);
});

test("DaytonaSandboxProvider connect and destroy use SDK lookups", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  const provider = new DaytonaSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env: { DAYTONA_API_KEY: "api-key" },
    }),
  );
  const created = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [7681],
  });

  const connected = await provider.connect("daytona-sbx");
  await expect(provider.destroy("daytona-sbx")).resolves.toBe(true);

  expect(connected).not.toBe(created);
  expect(connected.home).toBe("/home/daytona");
  expect(daytonaMocks.get).toHaveBeenCalledTimes(2);
  expect(daytonaMocks.get).toHaveBeenNthCalledWith(1, "daytona-sbx");
  expect(daytonaMocks.get).toHaveBeenNthCalledWith(2, "daytona-sbx");
  expect(daytonaMocks.deleteSandbox).toHaveBeenCalledWith(600);
});

test("DaytonaSandboxProvider missing package throws install hint", async () => {
  vi.resetModules();
  vi.doMock("@daytona/sdk", () => {
    throw new Error("Cannot find package '@daytona/sdk'");
  });
  const { DaytonaSandboxProvider } =
    await import("../../src/providers/daytona/index.js");
  const provider = new DaytonaSandboxProvider(
    new FakeHost({ home: "/home/local", env: { DAYTONA_API_KEY: "api-key" } }),
  );

  await expect(
    provider.create({
      envs: {},
      timeoutMs: 600000,
      ports: [7681],
    }),
  ).rejects.toThrow(
    "The 'daytona' provider needs @daytona/sdk. Run: npm i @daytona/sdk",
  );
});
