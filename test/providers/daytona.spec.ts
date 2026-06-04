import { Buffer } from "node:buffer";
import { expect, test, vi } from "vitest";
import { FakeHost } from "../fakes/host.js";

const daytonaMocks = vi.hoisted(() => {
  const executeCommand = vi.fn(async () => ({
    exitCode: 3,
    result: "combined",
  }));
  const createSession = vi.fn(async () => undefined);
  const executeSessionCommand = vi.fn(async () => undefined);
  const uploadFile = vi.fn(async () => undefined);
  const getPreviewLink = vi.fn(async () => ({
    url: "https://daytona-preview.example",
    token: "preview-token",
  }));
  const deleteSandbox = vi.fn(async () => undefined);
  const sandbox = {
    id: "daytona-sbx",
    process: { executeCommand, createSession, executeSessionCommand },
    fs: { uploadFile },
    getPreviewLink,
    delete: deleteSandbox,
  };
  const create = vi.fn(async () => sandbox);
  const get = vi.fn(async () => sandbox);
  const list = vi.fn(async () => [sandbox]);
  const Daytona = vi.fn(() => ({ create, get, list }));
  return {
    Daytona,
    create,
    createSession,
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
  vi.doMock("@daytonaio/sdk", () => ({ Daytona: daytonaMocks.Daytona }));
  return import("../../src/providers/daytona/index.js");
};

test("DaytonaSandboxProvider creates a sandbox and maps combined exec output", async () => {
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
    image: "node:22",
    envs: { A: "1" },
    timeoutMs: 600000,
    ports: [7681],
  });

  await expect(sandbox.exec("echo ok")).resolves.toEqual({
    exitCode: 3,
    stdout: "combined",
    stderr: "",
  });
  expect(daytonaMocks.Daytona).toHaveBeenCalledWith({
    apiKey: "api-key",
    apiUrl: "https://api.daytona.example",
    target: "target",
  });
  expect(daytonaMocks.create).toHaveBeenCalledWith(
    {
      image: "node:22",
      envVars: { A: "1" },
      autoStopInterval: 10,
      ephemeral: true,
    },
    { timeout: 600 },
  );
  expect(daytonaMocks.executeCommand).toHaveBeenCalledWith(
    "bash -lc 'echo ok'",
    undefined,
    undefined,
    600,
  );
});

test("DaytonaSandboxProvider spawn uses one async session", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  const provider = new DaytonaSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env: { DAYTONA_API_KEY: "api-key" },
    }),
  );
  const sandbox = await provider.create({ envs: {}, timeoutMs: 600000 });

  await sandbox.spawn("ttyd");
  await sandbox.spawn("cloudflared");

  expect(daytonaMocks.createSession).toHaveBeenCalledTimes(1);
  expect(daytonaMocks.executeSessionCommand).toHaveBeenNthCalledWith(
    1,
    "keepon",
    { command: "ttyd", runAsync: true },
  );
  expect(daytonaMocks.executeSessionCommand).toHaveBeenNthCalledWith(
    2,
    "keepon",
    { command: "cloudflared", runAsync: true },
  );
});

test("DaytonaSandboxProvider uploads files, exposes ports, and destroys", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  const provider = new DaytonaSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env: { DAYTONA_API_KEY: "api-key" },
    }),
  );
  const sandbox = await provider.create({ envs: {}, timeoutMs: 600000 });

  await sandbox.uploadFile("/tmp/a", "hello");
  await sandbox.uploadFile("/tmp/b", new Uint8Array([1, 2]));
  await sandbox.uploadPath("/tmp/profile.tgz", "/local/profile.tgz");
  await expect(sandbox.exposePort(7681)).resolves.toEqual({
    url: "https://daytona-preview.example",
    token: "preview-token",
    authGatedByProvider: false,
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
  const created = await provider.create({ envs: {}, timeoutMs: 600000 });

  const connected = await provider.connect("daytona-sbx");
  await expect(provider.destroy("daytona-sbx")).resolves.toBe(true);

  expect(connected).not.toBe(created);
  expect(daytonaMocks.get).toHaveBeenCalledTimes(2);
  expect(daytonaMocks.get).toHaveBeenNthCalledWith(1, "daytona-sbx");
  expect(daytonaMocks.get).toHaveBeenNthCalledWith(2, "daytona-sbx");
  expect(daytonaMocks.deleteSandbox).toHaveBeenCalledWith(600);
});

test("DaytonaSandboxProvider missing package throws install hint", async () => {
  vi.resetModules();
  vi.doMock("@daytonaio/sdk", () => {
    throw new Error("Cannot find package '@daytonaio/sdk'");
  });
  const { DaytonaSandboxProvider } =
    await import("../../src/providers/daytona/index.js");
  const provider = new DaytonaSandboxProvider(
    new FakeHost({ home: "/home/local", env: { DAYTONA_API_KEY: "api-key" } }),
  );

  await expect(
    provider.create({ envs: {}, timeoutMs: 600000 }),
  ).rejects.toThrow(
    "The 'daytona' provider needs @daytonaio/sdk. Run: npm i @daytonaio/sdk",
  );
});
