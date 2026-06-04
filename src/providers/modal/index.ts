import type {
  ModalClient as ModalClientType,
  Sandbox as ModalSandboxInstance,
} from "modal";
import type { HostDeps } from "../../core/ports/host.js";
import type {
  Capability,
  CreateOptions,
  ExposedPort,
  RunResult,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
} from "../../core/ports/provider.js";

type ModalModule = typeof import("modal");

const COMMAND_TIMEOUT_MS = 600000;
const TUNNEL_TIMEOUT_MS = 60000;

const MODAL_INSTALL_HINT =
  "The 'modal' provider needs the 'modal' package. Run: npm i modal";

interface ErrorWithCause {
  cause?: unknown;
}

const errorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as ErrorWithCause).cause;
  if (cause === undefined) return error.message;
  return `${error.message}\n${errorText(cause)}`;
};

const encoder = new TextEncoder();

const isMissingModalPackage = (error: unknown): boolean => {
  const text = errorText(error);
  return (
    text.includes("Cannot find package 'modal'") ||
    text.includes('Cannot find package "modal"') ||
    text.includes("Cannot find module 'modal'") ||
    text.includes('Cannot find module "modal"')
  );
};

const loadModal = async (): Promise<ModalModule> => {
  try {
    return await import("modal");
  } catch (error: unknown) {
    if (isMissingModalPackage(error)) throw new Error(MODAL_INSTALL_HINT);
    throw error;
  }
};

const bytesFromData = (data: Uint8Array | string): Uint8Array =>
  typeof data === "string" ? encoder.encode(data) : data;

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
      await file.write(bytesFromData(data));
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
    return { url: `https://${tunnel.host}`, authGatedByProvider: false };
  }

  async setTimeout(timeoutMs: number): Promise<void> {
    timeoutMs;
  }

  async destroy(): Promise<void> {
    await this.sandbox.terminate();
  }
}

export class ModalSandboxProvider implements SandboxProvider {
  readonly name = "modal";
  readonly capabilities: ReadonlySet<Capability> = new Set([
    "background-exec",
    "live-file-upload",
  ]);
  readonly instances: Record<string, ModalSandboxAdapter> = {};
  readonly host: Pick<HostDeps, "env" | "openBlob">;

  constructor(host: Pick<HostDeps, "env" | "openBlob">) {
    this.host = host;
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
    return this.track(sandbox);
  }

  async connect(id: string): Promise<Sandbox> {
    if (this.instances[id] !== undefined) return this.instances[id];
    return this.track(await (await this.client()).sandboxes.fromId(id));
  }

  async list(): Promise<SandboxInfo[]> {
    const sandboxes: SandboxInfo[] = [];
    for await (const sandbox of (await this.client()).sandboxes.list())
      sandboxes.push({ id: sandbox.sandboxId, startedAt: new Date(0) });
    return sandboxes;
  }

  async destroy(id: string): Promise<boolean> {
    if (this.instances[id] !== undefined) {
      await this.instances[id].destroy();
      delete this.instances[id];
      return true;
    }
    try {
      const sandbox = await (await this.client()).sandboxes.fromId(id);
      await sandbox.terminate();
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "NotFoundError")
        return false;
      throw error;
    }
  }

  private async client(): Promise<ModalClientType> {
    const { ModalClient } = await loadModal();
    const tokenId = this.host.env.MODAL_TOKEN_ID;
    const tokenSecret = this.host.env.MODAL_TOKEN_SECRET;
    if (tokenId === undefined)
      throw new Error("MODAL_TOKEN_ID is required for modal provider");
    if (tokenSecret === undefined)
      throw new Error("MODAL_TOKEN_SECRET is required for modal provider");
    return new ModalClient({ tokenId, tokenSecret });
  }

  private track(sandbox: ModalSandboxInstance): Sandbox {
    const adapter = new ModalSandboxAdapter(sandbox, this.host);
    this.instances[adapter.id] = adapter;
    return adapter;
  }
}
