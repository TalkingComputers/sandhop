import { Buffer } from "node:buffer";
import { expect, test, vi } from "vitest";
import { FakeHost } from "../fakes/host.js";

const vercelMocks = vi.hoisted(() => {
  const stdout = vi.fn(async () => "stdout");
  const stderr = vi.fn(async () => "stderr");
  const runCommand = vi.fn(async () => ({ exitCode: 5, stdout, stderr }));
  const mkDir = vi.fn(async () => undefined);
  const writeFiles = vi.fn(async () => undefined);
  const domain = vi.fn((port: number) => `https://vercel-${port}.example`);
  const extendTimeout = vi.fn(async () => undefined);
  const update = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const sandbox = {
    name: "sdk-name",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    runCommand,
    mkDir,
    writeFiles,
    domain,
    extendTimeout,
    update,
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
    extendTimeout,
    get,
    list,
    mkDir,
    runCommand,
    stderr,
    stop,
    stdout,
    update,
    writeFiles,
  };
});

const env = {
  VERCEL_TOKEN: "token",
  VERCEL_TEAM_ID: "team",
  VERCEL_PROJECT_ID: "project",
};

const loadProvider = async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock("@vercel/sandbox", () => ({ Sandbox: vercelMocks.Sandbox }));
  return import("../../src/providers/vercel/index.js");
};

test("VercelSandboxProvider creates a named sandbox with creds and maps exec results", async () => {
  const { VercelSandboxProvider } = await loadProvider();
  const provider = new VercelSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );

  const sandbox = await provider.create({
    image: "ignored",
    envs: { A: "1" },
    timeoutMs: 3_600_000,
    ports: [3000, 7681],
  });

  await expect(sandbox.exec("echo ok")).resolves.toEqual({
    exitCode: 5,
    stdout: "stdout",
    stderr: "stderr",
  });
  expect(vercelMocks.create).toHaveBeenCalledWith({
    token: "token",
    teamId: "team",
    projectId: "project",
    name: expect.stringMatching(/^keepon-/),
    timeout: 3_600_000,
    ports: [3000, 7681],
    runtime: "node22",
  });
  expect(sandbox.id).toBe(
    (vercelMocks.create.mock.calls[0]![0] as { name: string }).name,
  );
  expect(vercelMocks.runCommand).toHaveBeenCalledWith("bash", [
    "-lc",
    "echo ok",
  ]);
  expect(vercelMocks.stdout).toHaveBeenCalled();
  expect(vercelMocks.stderr).toHaveBeenCalled();
});

test("VercelSandboxProvider spawn uses detached bash and upload uses mkdir plus writeFiles", async () => {
  const { VercelSandboxProvider } = await loadProvider();
  const provider = new VercelSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env,
      bytes: { "/local/profile.tgz": new Uint8Array([9, 8]) },
    }),
  );
  const sandbox = await provider.create({ envs: {}, timeoutMs: 600000 });

  await sandbox.spawn("ttyd");
  await sandbox.uploadFile("/tmp/nested/a.txt", "hello");
  await sandbox.uploadFile("/tmp/b.bin", new Uint8Array([1, 2]));
  await sandbox.uploadPath("/tmp/profile.tgz", "/local/profile.tgz");
  await expect(sandbox.exposePort(7681)).resolves.toEqual({
    url: "https://vercel-7681.example",
    authGatedByProvider: false,
  });
  await sandbox.setTimeout(120000);
  await sandbox.destroy();

  expect(vercelMocks.runCommand).toHaveBeenCalledWith({
    cmd: "bash",
    args: ["-lc", "ttyd"],
    detached: true,
  });
  expect(vercelMocks.mkDir).toHaveBeenCalledWith("/tmp/nested");
  expect(vercelMocks.writeFiles).toHaveBeenCalledWith([
    { path: "/tmp/nested/a.txt", content: Buffer.from("hello") },
  ]);
  expect(vercelMocks.writeFiles).toHaveBeenCalledWith([
    { path: "/tmp/b.bin", content: Buffer.from(new Uint8Array([1, 2])) },
  ]);
  expect(vercelMocks.writeFiles).toHaveBeenCalledWith([
    { path: "/tmp/profile.tgz", content: Buffer.from(new Uint8Array([9, 8])) },
  ]);
  expect(vercelMocks.domain).toHaveBeenCalledWith(7681);
  expect(vercelMocks.extendTimeout).toHaveBeenCalledWith(120000);
  expect(vercelMocks.update).not.toHaveBeenCalled();
  expect(vercelMocks.stop).toHaveBeenCalled();
});

test("VercelSandboxProvider reconnects by name and reuses live instances", async () => {
  const { VercelSandboxProvider } = await loadProvider();
  const provider = new VercelSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );

  const created = await provider.create({ envs: {}, timeoutMs: 600000 });
  await expect(provider.connect(created.id)).resolves.toBe(created);
  expect(vercelMocks.get).not.toHaveBeenCalled();

  const connected = await provider.connect("keepon-existing");

  expect(connected.id).toBe("keepon-existing");
  expect(vercelMocks.get).toHaveBeenCalledWith({
    token: "token",
    teamId: "team",
    projectId: "project",
    name: "keepon-existing",
    resume: true,
  });
});

test("VercelSandboxProvider lists and destroys sandboxes by name", async () => {
  const { VercelSandboxProvider } = await loadProvider();
  const provider = new VercelSandboxProvider(
    new FakeHost({ home: "/home/local", env }),
  );

  await expect(provider.list()).resolves.toEqual([
    { id: "sdk-name", startedAt: new Date("2026-06-01T00:00:00Z") },
  ]);
  await expect(provider.destroy("keepon-existing")).resolves.toBe(true);

  expect(vercelMocks.list).toHaveBeenCalledWith({
    token: "token",
    teamId: "team",
    projectId: "project",
    limit: 100,
  });
  expect(vercelMocks.get).toHaveBeenCalledWith({
    token: "token",
    teamId: "team",
    projectId: "project",
    name: "keepon-existing",
  });
  expect(vercelMocks.stop).toHaveBeenCalled();
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
    provider.create({ envs: {}, timeoutMs: 600000 }),
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
      provider.create({ envs: {}, timeoutMs: 600000 }),
    ).rejects.toThrow(`${key} is required for vercel provider`);
  }
});
