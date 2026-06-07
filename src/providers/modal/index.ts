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
} from "../../core/ports/provider.js";
import { shellQuote } from "../../core/shell.js";
import { destroyOrFalse } from "../destroy.js";
import { requireCred } from "../index.js";
import { lazyImport, lazyOnce } from "../lazy-import.js";
import {
  GenericSandbox,
  readSandboxHome,
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

const nodeImage = (): string => {
  const major = Number(process.versions.node.split(".", 1)[0]);
  if (!Number.isInteger(major))
    throw new Error(`Invalid Node version ${process.versions.node}`);
  return `node:${major}`;
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
      `nohup bash -lc ${shellQuote(cmd)} >/dev/null 2>&1 &`,
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
    const client = await this.client();
    const app = await client.apps.fromName("sandhop", {
      createIfMissing: true,
    });
    const image = client.images
      .fromRegistry(nodeImage())
      .dockerfileCommands([
        "RUN apt-get update && apt-get install -y --no-install-recommends zstd",
      ]);
    const sandbox = await client.sandboxes.create(app, image, {
      command: ["sleep", "infinity"],
      cpu: MODAL_SANDBOX_CPU_CORES,
      encryptedPorts: opts.ports,
      env: opts.envs,
      memoryMiB: MODAL_SANDBOX_MEMORY_MIB,
      timeoutMs: opts.timeoutMs,
    });
    try {
      const ops = makeOps(sandbox);
      return new GenericSandbox(
        sandbox.sandboxId,
        await readSandboxHome(ops.exec),
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
    return new GenericSandbox(id, await readSandboxHome(ops.exec), ops);
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
