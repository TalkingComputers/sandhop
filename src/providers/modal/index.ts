import type {
  ModalClient as ModalClientType,
  Sandbox as ModalSandboxInstance,
} from "modal";
import type { HostDeps } from "../../core/ports/host.js";
import type {
  CreateOptions,
  RunResult,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
  SandboxRuntime,
} from "../../core/ports/provider.js";
import { quote } from "shell-quote";
import { destroyOrFalse } from "../destroy.js";
import { requireCred } from "../index.js";
import { lazyImport, lazyOnce } from "../lazy-import.js";
import {
  createSandbox,
  renderDetachedShell,
  renderShellCall,
  type SandboxOps,
} from "../sandbox-adapter.js";

type ModalModule = typeof import("modal");

interface ModalSandboxListItem {
  sandboxId: string;
}

const COMMAND_TIMEOUT_MS = 600000;
const TUNNEL_TIMEOUT_MS = 60000;
const MODAL_SANDBOX_CPU_CORES = 4;
const MODAL_SANDBOX_MEMORY_MIB = 4096;

const MODAL_INSTALL_HINT =
  "The 'modal' provider needs the 'modal' package. Run: npm i modal";
const MODAL_PACKAGE = "modal";
const MODAL_SPAWN_LOG = "/tmp/sandhop-spawn.log";
const LINUX_USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/;

type ModalRuntime = Pick<SandboxRuntime, "home" | "username">;
interface ModalProcess {
  stdout: { readText(): Promise<string> };
  stderr: { readText(): Promise<string> };
  wait(): Promise<number>;
}

const nodeImage = (): string => {
  const major = Number(process.versions.node.split(".", 1)[0]);
  if (!Number.isInteger(major))
    throw new Error(`Invalid Node version ${process.versions.node}`);
  return `node:${major}`;
};

const validateLinuxUsername = (username: string): string => {
  if (!LINUX_USERNAME.test(username))
    throw new Error(
      `Modal runtime username must be a Linux username: ${username}`,
    );
  return username;
};

const validateRuntimePath = (path: string, label: string): string => {
  if (!path.startsWith("/") || path.includes("\n") || path.includes("\r"))
    throw new Error(`Modal runtime ${label} must be an absolute path: ${path}`);
  return path;
};

const buildModalDockerfileCommands = (runtime: SandboxRuntime): string[] => {
  const username = validateLinuxUsername(runtime.username);
  const home = validateRuntimePath(runtime.home, "home");
  const workdir = validateRuntimePath(runtime.workdir, "workdir");
  const owner = quote([`${username}:${username}`]);
  const createUser = [
    `mkdir -p ${quote([home])} ${quote([workdir])}`,
    `useradd --user-group --home-dir ${quote([home])} --shell /bin/bash ${quote([username])}`,
    `chown -R ${owner} ${quote([home])} ${quote([workdir])}`,
  ].join(" && ");
  return [
    "RUN apt-get update && apt-get install -y --no-install-recommends zstd util-linux",
    `RUN ${createUser}`,
    `ENV HOME=${home}`,
  ];
};

const modalRuntimeCommand = (runtime: ModalRuntime, cmd: string): string[] => [
  "runuser",
  "-u",
  runtime.username,
  "--",
  "env",
  `HOME=${runtime.home}`,
  "bash",
  "-lc",
  cmd,
];

const readModalProcess = async (process: ModalProcess): Promise<RunResult> => {
  const [stdout, stderr, exitCode] = await Promise.all([
    process.stdout.readText(),
    process.stderr.readText(),
    process.wait(),
  ]);
  return { exitCode, stdout, stderr };
};

const execModal = async (
  sandbox: ModalSandboxInstance,
  command: string[],
  timeoutMs: number,
): Promise<RunResult> => {
  const process = await sandbox.exec(command, { timeoutMs });
  return readModalProcess(process);
};

const readStoredModalRuntime = async (
  sandbox: ModalSandboxInstance,
): Promise<ModalRuntime> => {
  const result = await execModal(
    sandbox,
    [
      "bash",
      "-lc",
      `printf '%s\\n%s\\n' "$SANDHOP_RUNTIME_HOME" "$SANDHOP_RUNTIME_USER"`,
    ],
    COMMAND_TIMEOUT_MS,
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Modal runtime env lookup failed: ${result.stderr.length > 0 ? result.stderr : result.stdout}`,
    );
  const [home, username] = result.stdout.trimEnd().split("\n");
  if (home === undefined || username === undefined)
    throw new Error(`Modal runtime env lookup failed: ${result.stdout}`);
  return {
    home: validateRuntimePath(home, "home"),
    username: validateLinuxUsername(username),
  };
};

const readModalRuntime = async (
  sandbox: ModalSandboxInstance,
  runtime: ModalRuntime,
): Promise<{ home: string; uid: string; username: string }> => {
  const result = await execModal(
    sandbox,
    modalRuntimeCommand(
      runtime,
      `printf '%s\\n%s\\n%s\\n' "$HOME" "$(id -u)" "$(id -un)"`,
    ),
    COMMAND_TIMEOUT_MS,
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Modal runtime lookup failed: ${result.stderr.length > 0 ? result.stderr : result.stdout}`,
    );
  const [home, uid, username] = result.stdout.trimEnd().split("\n");
  if (home === undefined || uid === undefined || username === undefined)
    throw new Error(`Modal runtime lookup failed: ${result.stdout}`);
  return { home, uid, username };
};

const assertModalRuntime = async (
  sandbox: ModalSandboxInstance,
  runtime: ModalRuntime,
): Promise<string> => {
  const actual = await readModalRuntime(sandbox, runtime);
  if (actual.home !== runtime.home)
    throw new Error(
      `Modal sandbox HOME mismatch: expected ${runtime.home} got ${actual.home}`,
    );
  if (actual.uid === "0") throw new Error("Modal sandbox must not run as root");
  if (actual.username !== runtime.username)
    throw new Error(
      `Modal sandbox username mismatch: expected ${runtime.username} got ${actual.username}`,
    );
  return actual.home;
};

const makeOps = (
  sandbox: ModalSandboxInstance,
  runtime: ModalRuntime,
): SandboxOps => ({
  uploadFile: async (path, data) => {
    if (typeof data === "string")
      await sandbox.filesystem.writeText(data, path);
    else await sandbox.filesystem.writeBytes(data, path);
  },

  uploadPath: async (remotePath, localPath) => {
    await sandbox.filesystem.copyFromLocal(localPath, remotePath);
  },

  exec: async (file, args, opts) => {
    return execModal(
      sandbox,
      [file, ...args],
      opts?.timeoutMs ?? COMMAND_TIMEOUT_MS,
    );
  },

  spawn: async (file, args, opts) => {
    await sandbox.exec(
      modalRuntimeCommand(
        runtime,
        renderDetachedShell(renderShellCall(file, args, opts), opts),
      ),
    );
  },

  exposePort: async (port) => {
    const tunnels = await sandbox.tunnels(TUNNEL_TIMEOUT_MS);
    const tunnel = tunnels[port];
    if (tunnel === undefined) throw new Error(`Modal tunnel ${port} not found`);
    return { url: `https://${tunnel.host}` };
  },

  destroy: async () => {
    await sandbox.terminate();
  },
});

export class ModalSandboxProvider implements SandboxProvider {
  readonly name = "modal";
  readonly host: Pick<HostDeps, "env" | "openBlob">;
  private readonly client: () => Promise<ModalClientType>;

  constructor(host: Pick<HostDeps, "env" | "openBlob">) {
    this.host = host;
    this.client = lazyOnce(() => this.createClient());
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    const dockerfileCommands = buildModalDockerfileCommands(opts.runtime);
    const client = await this.client();
    const app = await client.apps.fromName("sandhop", {
      createIfMissing: true,
    });
    const image = client.images
      .fromRegistry(nodeImage())
      .dockerfileCommands(dockerfileCommands);
    const sandbox = await client.sandboxes.create(app, image, {
      command: ["sleep", "infinity"],
      cpu: MODAL_SANDBOX_CPU_CORES,
      encryptedPorts: opts.ports,
      env: {
        ...opts.envs,
        HOME: opts.runtime.home,
        SANDHOP_RUNTIME_HOME: opts.runtime.home,
        SANDHOP_RUNTIME_USER: opts.runtime.username,
      },
      memoryMiB: MODAL_SANDBOX_MEMORY_MIB,
      timeoutMs: opts.timeoutMs,
      workdir: opts.runtime.workdir,
    });
    try {
      const ops = makeOps(sandbox, opts.runtime);
      return createSandbox(
        sandbox.sandboxId,
        await assertModalRuntime(sandbox, opts.runtime),
        ops,
      );
    } catch (error: unknown) {
      await sandbox.terminate().catch(() => undefined);
      throw error;
    }
  }

  async connect(id: string): Promise<Sandbox> {
    const sandbox = await (await this.client()).sandboxes.fromId(id);
    const runtime = await readStoredModalRuntime(sandbox);
    const ops = makeOps(sandbox, runtime);
    return createSandbox(id, await assertModalRuntime(sandbox, runtime), ops);
  }

  async list(): Promise<SandboxInfo[]> {
    const sandboxes: SandboxInfo[] = [];
    const listed = (
      await this.client()
    ).sandboxes.list() as AsyncIterable<ModalSandboxListItem>;
    for await (const sandbox of listed)
      sandboxes.push({
        id: sandbox.sandboxId,
        startedAt: new Date(0),
      });
    return sandboxes;
  }

  async destroy(id: string): Promise<boolean> {
    return destroyOrFalse(
      (error) => error instanceof Error && error.name === "NotFoundError",
      async () => {
        const sandbox = await (await this.client()).sandboxes.fromId(id);
        await sandbox.terminate();
      },
    );
  }

  private async createClient(): Promise<ModalClientType> {
    const { ModalClient } = await lazyImport<ModalModule>(
      MODAL_PACKAGE,
      MODAL_INSTALL_HINT,
    );
    const credentials = {
      tokenId: requireCred(this.host, "modal", "MODAL_TOKEN_ID"),
      tokenSecret: requireCred(this.host, "modal", "MODAL_TOKEN_SECRET"),
    };
    return new ModalClient({
      tokenId: credentials.tokenId,
      tokenSecret: credentials.tokenSecret,
    });
  }
}
