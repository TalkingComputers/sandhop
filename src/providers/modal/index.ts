import type {
  ModalClient as ModalClientType,
  Sandbox as ModalSandboxInstance,
} from "modal";
import type { HostDeps } from "../../core/ports/host.js";
import type {
  CreateOptions,
  ExposedPort,
  RunResult,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
} from "../../core/ports/provider.js";
import { destroyOrFalse } from "../destroy.js";
import { toBytes } from "../encode.js";
import { requireCredentials } from "../index.js";
import { lazyImport, lazyOnce } from "../lazy-import.js";

type ModalModule = typeof import("modal");

const COMMAND_TIMEOUT_MS = 600000;
const TUNNEL_TIMEOUT_MS = 60000;

const MODAL_INSTALL_HINT =
  "The 'modal' provider needs the 'modal' package. Run: npm i modal";
const MODAL_PACKAGE = "modal";

class ModalSandboxAdapter implements Sandbox {
  readonly id: string;
  readonly sandbox: ModalSandboxInstance;
  readonly host: Pick<HostDeps, "openBlob">;

  constructor(sandbox: ModalSandboxInstance, host: Pick<HostDeps, "openBlob">) {
    this.sandbox = sandbox;
    this.host = host;
    this.id = sandbox.sandboxId;
  }

  async uploadFile(path: string, data: Uint8Array | string): Promise<void> {
    const file = await this.sandbox.open(path, "w");
    try {
      await file.write(toBytes(data));
    } finally {
      await file.close();
    }
  }

  async uploadPath(remotePath: string, localPath: string): Promise<void> {
    const file = await this.sandbox.open(remotePath, "w");
    try {
      for await (const chunk of (await this.host.openBlob(localPath)).stream())
        await file.write(chunk);
    } finally {
      await file.close();
    }
  }

  async exec(cmd: string): Promise<RunResult> {
    const process = await this.sandbox.exec(["bash", "-lc", cmd], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      process.stdout.readText(),
      process.stderr.readText(),
      process.wait(),
    ]);
    return { exitCode, stdout, stderr };
  }

  async spawn(cmd: string): Promise<void> {
    await this.sandbox.exec(["bash", "-lc", cmd]);
  }

  async exposePort(port: number): Promise<ExposedPort> {
    const tunnels = await this.sandbox.tunnels(TUNNEL_TIMEOUT_MS);
    const tunnel = tunnels[port];
    if (tunnel === undefined) throw new Error(`Modal tunnel ${port} not found`);
    return { url: `https://${tunnel.host}` };
  }

  async destroy(): Promise<void> {
    await this.sandbox.terminate();
  }
}

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
    const app = await client.apps.fromName("keepon", { createIfMissing: true });
    const image = client.images.fromRegistry(opts.image ?? "node:22");
    const sandbox = await client.sandboxes.create(app, image, {
      command: ["sleep", "infinity"],
      encryptedPorts: opts.ports ?? [7681],
      env: opts.envs,
      timeoutMs: opts.timeoutMs,
    });
    return new ModalSandboxAdapter(sandbox, this.host);
  }

  async connect(id: string): Promise<Sandbox> {
    return new ModalSandboxAdapter(
      await (await this.client()).sandboxes.fromId(id),
      this.host,
    );
  }

  async list(): Promise<SandboxInfo[]> {
    const sandboxes: SandboxInfo[] = [];
    for await (const sandbox of (await this.client()).sandboxes.list())
      sandboxes.push({ id: sandbox.sandboxId, startedAt: new Date(0) });
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
    const credentials = requireCredentials(this.host, "modal");
    return new ModalClient({
      tokenId: credentials.MODAL_TOKEN_ID,
      tokenSecret: credentials.MODAL_TOKEN_SECRET,
    });
  }
}
