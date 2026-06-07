import type {
  ModalClient as ModalClientType,
  Sandbox as ModalSandboxInstance,
} from "modal";
import type { HostDeps } from "../../core/ports/host.js";
import type {
  CreateOptions,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
  SandboxRuntime,
} from "../../core/ports/provider.js";
import { shellQuote } from "../../core/shell.js";
import { destroyOrFalse } from "../destroy.js";
import { requireCred } from "../index.js";
import { lazyImport, lazyOnce } from "../lazy-import.js";
import { GenericSandbox, type SandboxOps } from "../sandbox-adapter.js";

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
  const owner = shellQuote(`${username}:${username}`);
  const createUser = [
    `mkdir -p ${shellQuote(home)} ${shellQuote(workdir)}`,
    `useradd --user-group --home-dir ${shellQuote(home)} --shell /bin/bash ${shellQuote(username)}`,
    `chown -R ${owner} ${shellQuote(home)} ${shellQuote(workdir)}`,
  ].join(" && ");
  return [
    "RUN apt-get update && apt-get install -y --no-install-recommends zstd sudo",
    `RUN ${createUser}`,
    `RUN printf '%s\\n' ${shellQuote(`${username} ALL=(ALL) NOPASSWD:ALL`)} > /etc/sudoers.d/sandhop-runtime && chmod 0440 /etc/sudoers.d/sandhop-runtime`,
    `ENV HOME=${home}`,
    `USER ${username}`,
  ];
};

const readModalRuntime = async (
  ops: SandboxOps,
): Promise<{ home: string; uid: string; username: string }> => {
  const result = await ops.exec(
    `printf '%s\\n%s\\n%s\\n' "$HOME" "$(id -u)" "$(id -un)"`,
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
  ops: SandboxOps,
  runtime: SandboxRuntime,
): Promise<string> => {
  const actual = await readModalRuntime(ops);
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

const makeOps = (sandbox: ModalSandboxInstance): SandboxOps => ({
  uploadFile: async (path, data) => {
    if (typeof data === "string")
      await sandbox.filesystem.writeText(data, path);
    else await sandbox.filesystem.writeBytes(data, path);
  },

  uploadPath: async (remotePath, localPath) => {
    await sandbox.filesystem.copyFromLocal(localPath, remotePath);
  },

  exec: async (cmd, opts) => {
    const process = await sandbox.exec(["bash", "-lc", cmd], {
      timeoutMs: opts?.timeoutMs ?? COMMAND_TIMEOUT_MS,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      process.stdout.readText(),
      process.stderr.readText(),
      process.wait(),
    ]);
    return { exitCode, stdout, stderr };
  },

  spawn: async (cmd) => {
    await sandbox.exec([
      "bash",
      "-lc",
      `nohup bash -lc ${shellQuote(cmd)} >> ${MODAL_SPAWN_LOG} 2>&1 &`,
    ]);
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
      env: { ...opts.envs, HOME: opts.runtime.home },
      memoryMiB: MODAL_SANDBOX_MEMORY_MIB,
      timeoutMs: opts.timeoutMs,
      workdir: opts.runtime.workdir,
    });
    try {
      const ops = makeOps(sandbox);
      return new GenericSandbox(
        sandbox.sandboxId,
        await assertModalRuntime(ops, opts.runtime),
        ops,
      );
    } catch (error: unknown) {
      await sandbox.terminate().catch(() => undefined);
      throw error;
    }
  }

  async connect(id: string): Promise<Sandbox> {
    const sandbox = await (await this.client()).sandboxes.fromId(id);
    const ops = makeOps(sandbox);
    const runtime = await readModalRuntime(ops);
    if (runtime.uid === "0")
      throw new Error("Modal sandbox must not run as root");
    return new GenericSandbox(id, runtime.home, ops);
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
