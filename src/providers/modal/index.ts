import type {
  ModalClient as ModalClientType,
  Sandbox as ModalSandboxInstance,
} from "modal";
import type {
  CreateOptions,
  RunResult,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
  SandboxRuntime,
} from "../../core/ports/provider.js";
import {
  buildRuntimeEnv,
  buildRuntimeMetadata,
  buildRuntimeUserScript,
  buildRunuserArgs,
  buildSandboxToolInstallScript,
  readRuntimeMetadata,
  renderUserCommand,
  validateRuntime,
} from "../../core/sandbox-runtime.js";
import { destroyOrFalse } from "../destroy.js";
import { requireCred, type ResolvedCredentials } from "../index.js";
import { lazyImport, lazyOnce } from "../lazy-import.js";
import {
  createSandbox,
  renderServiceShell,
  type ProviderOps,
  type ResolvedExecOptions,
} from "../sandbox-adapter.js";

type ModalModule = typeof import("modal");

interface ModalCredentials {
  tokenId: string;
  tokenSecret: string;
}

interface ModalSandboxListItem {
  sandboxId: string;
}

const TUNNEL_TIMEOUT_MS = 60000;
const MODAL_SANDBOX_CPU_CORES = 4;
const MODAL_SANDBOX_MEMORY_MIB = 4096;

const MODAL_INSTALL_HINT =
  "The 'modal' provider needs the 'modal' package. Run: npm i modal";
const MODAL_PACKAGE = "modal";

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

const buildModalDockerfileCommands = (
  runtime: SandboxRuntime,
  agentInstall?: string,
): string[] => {
  const valid = validateRuntime(runtime);
  return [
    "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git jq unzip zstd tmux util-linux",
    `RUN ${buildRuntimeUserScript(valid)}`,
    `RUN ${buildSandboxToolInstallScript()}`,
    ...(agentInstall === undefined
      ? []
      : [`RUN ${renderUserCommand(valid, agentInstall)}`]),
    `ENV HOME=${valid.home}`,
  ];
};

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
  opts: ResolvedExecOptions,
): Promise<RunResult> => {
  const process = await sandbox.exec(command, {
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    workdir: opts.cwd,
  });
  return readModalProcess(process);
};

const makeOps = (
  sandbox: ModalSandboxInstance,
  runtime: SandboxRuntime,
): ProviderOps => ({
  uploadFile: async (path, data) => {
    if (typeof data === "string")
      await sandbox.filesystem.writeText(data, path);
    else await sandbox.filesystem.writeBytes(data, path);
  },

  uploadPath: async (remotePath, localPath) => {
    await sandbox.filesystem.copyFromLocal(localPath, remotePath);
  },

  exec: (file, args, opts) => execModal(sandbox, [file, ...args], opts),

  spawnService: async (service) => {
    await sandbox.exec(buildRunuserArgs(runtime, renderServiceShell(service)), {
      env: buildRuntimeEnv(runtime),
      workdir: runtime.workdir,
    });
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
  readonly credentials: ModalCredentials;
  private readonly client: () => Promise<ModalClientType>;

  constructor(credentials: ResolvedCredentials) {
    this.credentials = {
      tokenId: requireCred(credentials, "MODAL_TOKEN_ID"),
      tokenSecret: requireCred(credentials, "MODAL_TOKEN_SECRET"),
    };
    this.client = lazyOnce(() => this.createClient());
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    const runtime = validateRuntime(opts.runtime);
    const dockerfileCommands = buildModalDockerfileCommands(
      runtime,
      opts.agentInstall,
    );
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
        ...buildRuntimeEnv(runtime),
      },
      memoryMiB: MODAL_SANDBOX_MEMORY_MIB,
      tags: buildRuntimeMetadata(runtime),
      timeoutMs: opts.timeoutMs,
      workdir: runtime.workdir,
    });
    return createSandbox(sandbox.sandboxId, runtime, makeOps(sandbox, runtime));
  }

  async connect(id: string): Promise<Sandbox> {
    const sandbox = await (await this.client()).sandboxes.fromId(id);
    const runtime = readRuntimeMetadata(await sandbox.getTags());
    return createSandbox(id, runtime, makeOps(sandbox, runtime));
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
    return new ModalClient({
      tokenId: this.credentials.tokenId,
      tokenSecret: this.credentials.tokenSecret,
    });
  }
}
