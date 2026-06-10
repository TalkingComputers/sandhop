import { Buffer } from "node:buffer";
import { expect, test, vi } from "vitest";
import { remotePath } from "../../src/core/paths.js";

const RUNTIME = {
  home: "/home/local",
  username: "local",
  workdir: "/workspace/project",
};

const daytonaMocks = vi.hoisted(() => {
  const executeCommand = vi.fn(async () => ({
    exitCode: 0,
    result: "",
  }));
  const createSession = vi.fn(async () => undefined);
  const executeSessionCommand = vi.fn(
    async (sessionId: string, req: { command: string; runAsync: boolean }) =>
      req.runAsync
        ? { cmdId: "cmd-1" }
        : req.command.includes("printf") &&
            req.command.includes("SANDHOP_RUNTIME")
          ? {
              exitCode: 0,
              stdout: "/home/local\nlocal\n/workspace/project\n",
              stderr: "",
            }
          : req.command.includes("echo ok")
            ? {
                exitCode: 0,
                stdout: "ok\n",
                stderr: "",
              }
            : req.command.includes("echo err")
              ? {
                  exitCode: 3,
                  stdout: "out\n",
                  stderr: "err\n",
                }
              : req.command.includes("cat /tmp/ttyd.log")
                ? {
                    exitCode: 0,
                    stdout: "ready",
                    stderr: "",
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
    labels: Record<string, string>;
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
    labels: {
      "sandhop.runtime.home": "/home/local",
      "sandhop.runtime.user": "local",
      "sandhop.runtime.workdir": "/workspace/project",
    },
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
  const image = {
    runCommands: vi.fn(() => image),
    env: vi.fn(() => image),
    workdir: vi.fn(() => image),
  };
  const Image = {
    base: vi.fn(() => image),
    debianSlim: vi.fn(() => image),
  };
  return {
    Daytona,
    Image,
    create,
    createSession,
    deleteSession,
    deleteSandbox,
    executeCommand,
    executeSessionCommand,
    get,
    getPreviewLink,
    image,
    list,
    sandbox,
    uploadFile,
  };
});

const loadProvider = async () => {
  vi.resetModules();
  vi.clearAllMocks();
  daytonaMocks.sandbox.createdAt = undefined;
  vi.doMock("@daytona/sdk", () => ({
    Daytona: daytonaMocks.Daytona,
    Image: daytonaMocks.Image,
  }));
  return import("../../src/providers/daytona/index.js");
};

test("DaytonaSandboxProvider creates a sandbox and maps session stdout and stderr", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  const provider = new DaytonaSandboxProvider({
    DAYTONA_API_KEY: "api-key",
    DAYTONA_API_URL: "https://api.daytona.example",
    DAYTONA_TARGET: "target",
  });

  const sandbox = await provider.create({
    envs: { A: "1" },
    timeoutMs: 600000,
    ports: [7681],
    runtime: RUNTIME,
  });
  expect(sandbox.home).toBe("/home/local");

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
  expect(daytonaMocks.Image.base).toHaveBeenCalledWith("node:22-bookworm-slim");
  expect(daytonaMocks.Image.debianSlim).not.toHaveBeenCalled();
  expect(daytonaMocks.image.runCommands).toHaveBeenCalledWith(
    "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends zstd tmux curl ca-certificates git jq unzip util-linux && rm -rf /var/lib/apt/lists/*",
    expect.any(String),
    expect.any(String),
  );
  expect(daytonaMocks.create).toHaveBeenCalledWith(
    {
      envVars: {
        A: "1",
        HOME: "/home/local",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        SANDHOP_RUNTIME_HOME: "/home/local",
        SANDHOP_RUNTIME_USER: "local",
        SANDHOP_RUNTIME_WORKDIR: "/workspace/project",
      },
      autoStopInterval: 10,
      ephemeral: true,
      image: daytonaMocks.image,
      labels: {
        "sandhop.runtime.home": "/home/local",
        "sandhop.runtime.user": "local",
        "sandhop.runtime.workdir": "/workspace/project",
      },
      public: true,
      resources: { cpu: 4, memory: 4, disk: 10 },
      user: "root",
    },
    { timeout: 600 },
  );
  expect(daytonaMocks.executeSessionCommand).toHaveBeenCalledWith(
    expect.stringMatching(/^sandhop-exec-/),
    {
      command: expect.stringContaining("echo ok"),
      runAsync: false,
      suppressInputEcho: true,
    },
    600,
  );
  expect(daytonaMocks.executeSessionCommand).toHaveBeenCalledWith(
    expect.stringMatching(/^sandhop-exec-/),
    {
      command: expect.stringContaining("echo slow"),
      runAsync: false,
      suppressInputEcho: true,
    },
    123,
  );
  expect(daytonaMocks.executeCommand).not.toHaveBeenCalledWith(
    "bash -lc 'printf %s \"$HOME\"'",
  );
});

test("DaytonaSandboxProvider rejects invalid runtime before sandbox create", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  daytonaMocks.create.mockClear();
  const provider = new DaytonaSandboxProvider({ DAYTONA_API_KEY: "api-key" });

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

  expect(daytonaMocks.create).not.toHaveBeenCalled();
});

test("DaytonaSandboxProvider runs non-bash exec env through env argv", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  const provider = new DaytonaSandboxProvider({ DAYTONA_API_KEY: "api-key" });
  const sandbox = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [],
    runtime: RUNTIME,
  });

  await sandbox.exec("node", ["-e", "process.stdout.write(process.env.HOME)"]);

  const command = (
    daytonaMocks.executeSessionCommand.mock.calls[0]![1] as { command: string }
  ).command;
  expect(command).toContain("cd /workspace/project && env HOME\\=/home/local ");
  expect(command).toContain(
    "SANDHOP_RUNTIME_WORKDIR\\=/workspace/project node -e",
  );
  expect(command).not.toContain("&& HOME\\=/home/local ");
});

test("DaytonaSandboxProvider startService starts async session commands", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  const provider = new DaytonaSandboxProvider({ DAYTONA_API_KEY: "api-key" });
  const sandbox = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [7681],
    runtime: RUNTIME,
  });
  daytonaMocks.executeCommand.mockClear();
  daytonaMocks.executeSessionCommand.mockClear();

  await sandbox.startService({
    file: "ttyd",
    args: [],
    port: 7681,
    readiness: {
      kind: "log",
      path: remotePath("/tmp/ttyd.log"),
      matches: [/ready/],
      timeoutMs: 100,
      intervalMs: 1,
    },
    stdoutPath: remotePath("/tmp/ttyd.log"),
    stderrPath: remotePath("/tmp/ttyd.log"),
  });

  expect(daytonaMocks.executeCommand).not.toHaveBeenCalled();
  expect(daytonaMocks.executeSessionCommand).toHaveBeenCalledWith(
    expect.stringMatching(/^sandhop-service-/),
    {
      command: expect.stringContaining("runuser -u local"),
      runAsync: true,
      suppressInputEcho: true,
    },
    600,
  );
  expect(daytonaMocks.executeSessionCommand).toHaveBeenCalledWith(
    expect.stringMatching(/^sandhop-exec-/),
    {
      command: expect.stringContaining("cat /tmp/ttyd.log"),
      runAsync: false,
      suppressInputEcho: true,
    },
    10,
  );
});

test("DaytonaSandboxProvider uses fixed command timeout after long create", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  const provider = new DaytonaSandboxProvider({ DAYTONA_API_KEY: "api-key" });
  const sandbox = await provider.create({
    envs: {},
    timeoutMs: 3_600_000,
    ports: [7681],
    runtime: RUNTIME,
  });
  daytonaMocks.executeCommand.mockClear();
  daytonaMocks.executeSessionCommand.mockClear();

  await sandbox.exec("echo", ["ok"]);
  await sandbox.startService({
    file: "ttyd",
    args: [],
    port: 7681,
    readiness: {
      kind: "log",
      path: remotePath("/tmp/ttyd.log"),
      matches: [/ready/],
      timeoutMs: 100,
      intervalMs: 1,
    },
    stdoutPath: remotePath("/tmp/ttyd.log"),
    stderrPath: remotePath("/tmp/ttyd.log"),
  });

  expect(daytonaMocks.executeSessionCommand).toHaveBeenNthCalledWith(
    1,
    expect.stringMatching(/^sandhop-exec-/),
    {
      command: expect.stringContaining("echo ok"),
      runAsync: false,
      suppressInputEcho: true,
    },
    600,
  );
  expect(daytonaMocks.executeSessionCommand).toHaveBeenNthCalledWith(
    2,
    expect.stringMatching(/^sandhop-service-/),
    {
      command: expect.stringContaining("runuser -u local"),
      runAsync: true,
      suppressInputEcho: true,
    },
    600,
  );
});

test("DaytonaSandboxProvider rejects missing and malformed createdAt", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  const provider = new DaytonaSandboxProvider({ DAYTONA_API_KEY: "api-key" });

  await expect(provider.list()).rejects.toThrow(
    "Daytona sandbox createdAt missing: daytona-sbx",
  );

  daytonaMocks.sandbox.createdAt = "not-a-date";
  await expect(provider.list()).rejects.toThrow(
    "Invalid Daytona sandbox createdAt: daytona-sbx",
  );
});

test("DaytonaSandboxProvider uploads files, exposes ports, and destroys", async () => {
  const { DaytonaSandboxProvider } = await loadProvider();
  const provider = new DaytonaSandboxProvider({ DAYTONA_API_KEY: "api-key" });
  const sandbox = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [7681],
    runtime: RUNTIME,
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
  const provider = new DaytonaSandboxProvider({ DAYTONA_API_KEY: "api-key" });
  const created = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [7681],
    runtime: RUNTIME,
  });

  const connected = await provider.connect("daytona-sbx");
  await expect(provider.destroy("daytona-sbx")).resolves.toBe(true);

  expect(connected).not.toBe(created);
  expect(connected.home).toBe("/home/local");
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
  const provider = new DaytonaSandboxProvider({ DAYTONA_API_KEY: "api-key" });

  await expect(
    provider.create({
      envs: {},
      timeoutMs: 600000,
      ports: [7681],
      runtime: RUNTIME,
    }),
  ).rejects.toThrow(
    "The 'daytona' provider needs @daytona/sdk. Run: npm i @daytona/sdk",
  );
});
