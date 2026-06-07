import { expect, test, vi } from "vitest";
import { FakeHost } from "../fakes/host.js";

const RUNTIME = {
  home: "/Users/parsabahraminejad",
  username: "parsabahraminejad",
  workdir: "/Users/parsabahraminejad/Desktop/project",
};

const runAsRuntime = (cmd: string): string[] => [
  "runuser",
  "-u",
  "parsabahraminejad",
  "--",
  "env",
  "HOME=/Users/parsabahraminejad",
  "bash",
  "-lc",
  cmd,
];

const modalMocks = vi.hoisted(() => {
  const stdoutReadText = vi.fn(async () => "stdout");
  const stderrReadText = vi.fn(async () => "stderr");
  const wait = vi.fn(async () => 7);
  const exec = vi.fn(async (command: string[]) =>
    command[0] === "runuser" &&
    command[8] === `printf '%s\\n%s\\n%s\\n' "$HOME" "$(id -u)" "$(id -un)"`
      ? {
          stdout: {
            readText: vi.fn(
              async () => "/Users/parsabahraminejad\n1000\nparsabahraminejad\n",
            ),
          },
          stderr: { readText: vi.fn(async () => "") },
          wait: vi.fn(async () => 0),
        }
      : command[0] === "bash" &&
          command[2] ===
            `printf '%s\\n%s\\n' "$SANDHOP_RUNTIME_HOME" "$SANDHOP_RUNTIME_USER"`
        ? {
            stdout: {
              readText: vi.fn(
                async () => "/Users/parsabahraminejad\nparsabahraminejad\n",
              ),
            },
            stderr: { readText: vi.fn(async () => "") },
            wait: vi.fn(async () => 0),
          }
        : {
            stdout: { readText: stdoutReadText },
            stderr: { readText: stderrReadText },
            wait,
          },
  );
  const writeText = vi.fn(async () => undefined);
  const writeBytes = vi.fn(async () => undefined);
  const copyFromLocal = vi.fn(async () => undefined);
  const tunnels = vi.fn(async () => ({
    7681: { host: "modal-host.example" },
  }));
  const terminate = vi.fn(async () => undefined);
  const sandbox = {
    sandboxId: "modal-sbx",
    exec,
    filesystem: { writeText, writeBytes, copyFromLocal },
    tunnels,
    terminate,
  };
  const fromName = vi.fn(async () => ({ appId: "app-id" }));
  const image = {
    image: "node-image",
    dockerfileCommands: vi.fn((commands: string[]) => ({
      image: "node-image",
      commands,
    })),
  };
  const fromRegistry = vi.fn(() => image);
  const create = vi.fn(async () => sandbox);
  const fromId = vi.fn(async () => sandbox);
  const list = vi.fn(async function* () {
    yield {
      sandboxId: "modal-sbx",
    };
  });
  const ModalClient = vi.fn(() => ({
    apps: { fromName },
    images: { fromRegistry },
    sandboxes: { create, fromId, list },
  }));
  return {
    ModalClient,
    copyFromLocal,
    create,
    exec,
    fromId,
    fromName,
    fromRegistry,
    image,
    list,
    sandbox,
    stderrReadText,
    stdoutReadText,
    terminate,
    tunnels,
    wait,
    writeBytes,
    writeText,
  };
});

const loadProvider = async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock("modal", () => ({ ModalClient: modalMocks.ModalClient }));
  return import("../../src/providers/modal/index.js");
};

const NODE_IMAGE = `node:${process.versions.node.split(".", 1)[0]!}`;

test("ModalSandboxProvider creates a sandhop sandbox and maps exec results", async () => {
  const { ModalSandboxProvider } = await loadProvider();
  const host = new FakeHost({
    home: "/home/local",
    env: { MODAL_TOKEN_ID: "id", MODAL_TOKEN_SECRET: "secret" },
  });
  const provider = new ModalSandboxProvider(host);

  const sandbox = await provider.create({
    envs: { A: "1" },
    timeoutMs: 600000,
    ports: [7681],
    runtime: RUNTIME,
  });
  expect(sandbox.home).toBe("/Users/parsabahraminejad");

  await expect(sandbox.exec("echo ok")).resolves.toEqual({
    exitCode: 7,
    stdout: "stdout",
    stderr: "stderr",
  });
  await sandbox.exec("echo slow", { timeoutMs: 123000 });
  expect(modalMocks.ModalClient).toHaveBeenCalledWith({
    tokenId: "id",
    tokenSecret: "secret",
  });
  expect(modalMocks.fromName).toHaveBeenCalledWith("sandhop", {
    createIfMissing: true,
  });
  expect(modalMocks.fromRegistry).toHaveBeenCalledWith(NODE_IMAGE);
  expect(modalMocks.image.dockerfileCommands).toHaveBeenCalledWith([
    "RUN apt-get update && apt-get install -y --no-install-recommends zstd util-linux",
    "RUN mkdir -p '/Users/parsabahraminejad' '/Users/parsabahraminejad/Desktop/project' && useradd --user-group --home-dir '/Users/parsabahraminejad' --shell /bin/bash 'parsabahraminejad' && chown -R 'parsabahraminejad:parsabahraminejad' '/Users/parsabahraminejad' '/Users/parsabahraminejad/Desktop/project'",
    "ENV HOME=/Users/parsabahraminejad",
  ]);
  expect(modalMocks.create).toHaveBeenCalledWith(
    { appId: "app-id" },
    {
      image: "node-image",
      commands: [
        "RUN apt-get update && apt-get install -y --no-install-recommends zstd util-linux",
        "RUN mkdir -p '/Users/parsabahraminejad' '/Users/parsabahraminejad/Desktop/project' && useradd --user-group --home-dir '/Users/parsabahraminejad' --shell /bin/bash 'parsabahraminejad' && chown -R 'parsabahraminejad:parsabahraminejad' '/Users/parsabahraminejad' '/Users/parsabahraminejad/Desktop/project'",
        "ENV HOME=/Users/parsabahraminejad",
      ],
    },
    {
      command: ["sleep", "infinity"],
      cpu: 4,
      encryptedPorts: [7681],
      env: {
        A: "1",
        HOME: "/Users/parsabahraminejad",
        SANDHOP_RUNTIME_HOME: "/Users/parsabahraminejad",
        SANDHOP_RUNTIME_USER: "parsabahraminejad",
      },
      memoryMiB: 4096,
      timeoutMs: 600000,
      workdir: "/Users/parsabahraminejad/Desktop/project",
    },
  );
  expect(modalMocks.exec).toHaveBeenCalledWith(
    runAsRuntime(`printf '%s\\n%s\\n%s\\n' "$HOME" "$(id -u)" "$(id -un)"`),
    { timeoutMs: 600000 },
  );
  expect(modalMocks.exec).toHaveBeenCalledWith(["bash", "-lc", "echo ok"], {
    timeoutMs: 600000,
  });
  expect(modalMocks.exec).toHaveBeenCalledWith(["bash", "-lc", "echo slow"], {
    timeoutMs: 123000,
  });
});

test("ModalSandboxProvider spawn starts without awaiting process completion", async () => {
  const { ModalSandboxProvider } = await loadProvider();
  const provider = new ModalSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env: { MODAL_TOKEN_ID: "id", MODAL_TOKEN_SECRET: "secret" },
    }),
  );
  const sandbox = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [7681],
    runtime: RUNTIME,
  });
  modalMocks.exec.mockClear();
  modalMocks.wait.mockClear();

  await sandbox.spawn("ttyd");

  expect(modalMocks.exec).toHaveBeenCalledWith(
    runAsRuntime("nohup bash -lc 'ttyd' >> /tmp/sandhop-spawn.log 2>&1 &"),
  );
  expect(modalMocks.wait).not.toHaveBeenCalled();
});

test("ModalSandboxProvider terminates a created sandbox when runtime lookup fails", async () => {
  const { ModalSandboxProvider } = await loadProvider();
  modalMocks.exec.mockResolvedValueOnce({
    stdout: { readText: vi.fn(async () => "") },
    stderr: { readText: vi.fn(async () => "runtime failed") },
    wait: vi.fn(async () => 1),
  });
  const provider = new ModalSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env: { MODAL_TOKEN_ID: "id", MODAL_TOKEN_SECRET: "secret" },
    }),
  );

  await expect(
    provider.create({
      envs: {},
      timeoutMs: 600000,
      ports: [7681],
      runtime: RUNTIME,
    }),
  ).rejects.toThrow("Modal runtime lookup failed: runtime failed");

  expect(modalMocks.terminate).toHaveBeenCalled();
});

test("ModalSandboxProvider rejects root runtime user command", async () => {
  const { ModalSandboxProvider } = await loadProvider();
  modalMocks.exec.mockResolvedValueOnce({
    stdout: {
      readText: vi.fn(
        async () => "/Users/parsabahraminejad\n0\nparsabahraminejad\n",
      ),
    },
    stderr: { readText: vi.fn(async () => "") },
    wait: vi.fn(async () => 0),
  });
  const provider = new ModalSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env: { MODAL_TOKEN_ID: "id", MODAL_TOKEN_SECRET: "secret" },
    }),
  );

  await expect(
    provider.create({
      envs: {},
      timeoutMs: 600000,
      ports: [7681],
      runtime: RUNTIME,
    }),
  ).rejects.toThrow("Modal sandbox must not run as root");

  expect(modalMocks.terminate).toHaveBeenCalled();
});

test("ModalSandboxProvider rejects invalid Linux runtime usernames", async () => {
  const { ModalSandboxProvider } = await loadProvider();
  const provider = new ModalSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env: { MODAL_TOKEN_ID: "id", MODAL_TOKEN_SECRET: "secret" },
    }),
  );

  await expect(
    provider.create({
      envs: {},
      timeoutMs: 600000,
      ports: [7681],
      runtime: {
        home: "/Users/Bad User",
        username: "Bad User",
        workdir: "/Users/Bad User/project",
      },
    }),
  ).rejects.toThrow(
    "Modal runtime username must be a Linux username: Bad User",
  );

  expect(modalMocks.create).not.toHaveBeenCalled();
});

test("ModalSandboxProvider uploads files, exposes ports, and destroys", async () => {
  const { ModalSandboxProvider } = await loadProvider();
  const provider = new ModalSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env: { MODAL_TOKEN_ID: "id", MODAL_TOKEN_SECRET: "secret" },
      bytes: { "/tmp/profile.tgz": new Uint8Array([9, 8]) },
    }),
  );
  const sandbox = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [7681],
    runtime: RUNTIME,
  });

  await sandbox.uploadFile("/tmp/nested/a", "hello");
  await sandbox.uploadFile("/tmp/b", new Uint8Array([1, 2]));
  await sandbox.uploadPath("/tmp/nested/profile.tgz", "/tmp/profile.tgz");
  await expect(sandbox.exposePort(7681)).resolves.toEqual({
    url: "https://modal-host.example",
  });
  await sandbox.destroy();

  expect(modalMocks.writeText).toHaveBeenCalledWith("hello", "/tmp/nested/a");
  expect(modalMocks.writeBytes).toHaveBeenCalledWith(
    new Uint8Array([1, 2]),
    "/tmp/b",
  );
  expect(modalMocks.copyFromLocal).toHaveBeenCalledWith(
    "/tmp/profile.tgz",
    "/tmp/nested/profile.tgz",
  );
  expect(modalMocks.tunnels).toHaveBeenCalledWith(60000);
  expect(modalMocks.terminate).toHaveBeenCalled();
});

test("ModalSandboxProvider connect and destroy use SDK lookups", async () => {
  const { ModalSandboxProvider } = await loadProvider();
  const provider = new ModalSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env: { MODAL_TOKEN_ID: "id", MODAL_TOKEN_SECRET: "secret" },
    }),
  );
  const created = await provider.create({
    envs: {},
    timeoutMs: 600000,
    ports: [7681],
    runtime: RUNTIME,
  });

  const connected = await provider.connect("modal-sbx");
  await expect(provider.list()).resolves.toEqual([
    { id: "modal-sbx", startedAt: new Date(0) },
  ]);
  await expect(provider.destroy("modal-sbx")).resolves.toBe(true);

  expect(connected).not.toBe(created);
  expect(connected.home).toBe("/Users/parsabahraminejad");
  expect(modalMocks.fromId).toHaveBeenCalledTimes(2);
  expect(modalMocks.fromId).toHaveBeenNthCalledWith(1, "modal-sbx");
  expect(modalMocks.fromId).toHaveBeenNthCalledWith(2, "modal-sbx");
  expect(modalMocks.terminate).toHaveBeenCalledTimes(1);
});

test("ModalSandboxProvider validates Node major before image lookup", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
  if (descriptor === undefined) throw new Error("Missing node version");
  Object.defineProperty(process.versions, "node", {
    value: "not-a-version",
    configurable: true,
  });
  try {
    const { ModalSandboxProvider } = await loadProvider();
    const provider = new ModalSandboxProvider(
      new FakeHost({
        home: "/home/local",
        env: { MODAL_TOKEN_ID: "id", MODAL_TOKEN_SECRET: "secret" },
      }),
    );

    await expect(
      provider.create({
        envs: {},
        timeoutMs: 600000,
        ports: [7681],
        runtime: RUNTIME,
      }),
    ).rejects.toThrow("Invalid Node version not-a-version");

    expect(modalMocks.fromRegistry).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process.versions, "node", descriptor);
  }
});

test("ModalSandboxProvider missing package throws install hint", async () => {
  vi.resetModules();
  vi.doMock("modal", () => {
    throw new Error("Cannot find package 'modal'");
  });
  const { ModalSandboxProvider } =
    await import("../../src/providers/modal/index.js");
  const provider = new ModalSandboxProvider(
    new FakeHost({
      home: "/home/local",
      env: { MODAL_TOKEN_ID: "id", MODAL_TOKEN_SECRET: "secret" },
    }),
  );

  await expect(
    provider.create({
      envs: {},
      timeoutMs: 600000,
      ports: [7681],
      runtime: RUNTIME,
    }),
  ).rejects.toThrow(
    "The 'modal' provider needs the 'modal' package. Run: npm i modal",
  );
});
