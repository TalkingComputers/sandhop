import { Buffer } from "node:buffer";
import { expect, test, vi } from "vitest";
import { FakeHost } from "../fakes/host.js";

const vercelMocks = vi.hoisted(() => {
  const stdout = vi.fn(async () => "stdout");
  const stderr = vi.fn(async () => "stderr");
  const runCommand = vi.fn(
    async (cmd: string | { cmd: string }, args?: string[]) =>
      cmd === "bash" && args?.[1] === 'printf %s "$HOME"'
        ? {
            exitCode: 0,
            stdout: vi.fn(async () => "/home/vercel-sandbox"),
            stderr: vi.fn(async () => ""),
          }
        : { exitCode: 5, stdout, stderr },
  );
  const mkDir = vi.fn(async () => undefined);
  const writeFiles = vi.fn(async () => undefined);
  const domain = vi.fn((port: number) => `https://vercel-${port}.example`);
  const stop = vi.fn(async () => undefined);
  const sandbox = {
    name: "sdk-name",
    createdAt: new Date("2026-06-01T00:00:00Z"),
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
  let nearest: (typeof VERCEL_NODE_MAJORS)[number] = VERCEL_NODE_MAJORS[0];
  for (const candidate of VERCEL_NODE_MAJORS)
    if (Math.abs(candidate - major) < Math.abs(nearest - major))
      nearest = candidate;
  return `node${nearest}`;
};

const VERCEL_RUNTIME = vercelRuntime();

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
    envs: { A: "1" },
    timeoutMs: 3_600_000,
    ports: [3000, 7681],
  });
  expect(sandbox.home).toBe("/home/vercel-sandbox");

  await expect(sandbox.exec("echo ok")).resolves.toEqual({
    exitCode: 5,
    stdout: "stdout",
    stderr: "stderr",
  });
  expect(vercelMocks.create).toHaveBeenCalledWith({
    token: "token",
    teamId: "team",
    projectId: "project",
    name: expect.stringMatching(/^sandhop-/),
    timeout: 3_600_000,
    ports: [3000, 7681],
    runtime: VERCEL_RUNTIME,
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
  const sandbox = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [7681],
  });

  await sandbox.spawn("ttyd");
  await sandbox.uploadFile("/tmp/nested/a.txt", "hello");
  await sandbox.uploadFile("/tmp/b.bin", new Uint8Array([1, 2]));
  await sandbox.uploadPath("/tmp/profile.tgz", "/local/profile.tgz");
  await expect(sandbox.exposePort(7681)).resolves.toEqual({
    url: "https://vercel-7681.example",
  });
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
  expect(vercelMocks.stop).toHaveBeenCalled();
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
  });
  const connectedCreated = await provider.connect(created.id);

  const connected = await provider.connect("sandhop-existing");
  await expect(provider.destroy(created.id)).resolves.toBe(true);

  expect(connectedCreated).not.toBe(created);
  expect(connectedCreated.home).toBe("/home/vercel-sandbox");
  expect(connected.id).toBe("sandhop-existing");
  expect(connected.home).toBe("/home/vercel-sandbox");
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
      }),
    ).rejects.toThrow(`${key} is required — set it or run \`sandhop setup\``);
  }
});
