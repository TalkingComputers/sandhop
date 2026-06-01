import { CommandExitError, Sandbox as E2bSandbox } from "e2b";
import { openAsBlob } from "node:fs";
import type {
  Capability,
  CreateOptions,
  ExposedPort,
  RunResult,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
} from "../../core/ports/provider.js";

type E2bSandboxInstance = Awaited<ReturnType<typeof E2bSandbox.create>>;

const UPLOAD_TIMEOUT_MS = 600000;
const PATH_UPLOAD_TIMEOUT_MS = 3_600_000;

const toArrayBuffer = (data: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
};

class E2bSandboxAdapter implements Sandbox {
  readonly id: string;
  readonly sandbox: E2bSandboxInstance;

  constructor(sandbox: E2bSandboxInstance) {
    this.sandbox = sandbox;
    this.id = sandbox.sandboxId;
  }

  async uploadFile(path: string, data: Uint8Array | string): Promise<void> {
    await this.sandbox.files.write(
      path,
      typeof data === "string" ? data : toArrayBuffer(data),
      { requestTimeoutMs: UPLOAD_TIMEOUT_MS, useOctetStream: true },
    );
  }

  async uploadPath(remotePath: string, localPath: string): Promise<void> {
    await this.sandbox.files.write(remotePath, await openAsBlob(localPath), {
      requestTimeoutMs: PATH_UPLOAD_TIMEOUT_MS,
      useOctetStream: true,
    });
  }

  async exec(cmd: string): Promise<RunResult> {
    try {
      const result = await this.sandbox.commands.run(cmd, {
        timeoutMs: UPLOAD_TIMEOUT_MS,
        requestTimeoutMs: UPLOAD_TIMEOUT_MS,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error: unknown) {
      if (error instanceof CommandExitError)
        return {
          exitCode: error.exitCode,
          stdout: error.stdout,
          stderr: error.stderr,
        };
      throw error;
    }
  }

  async spawn(cmd: string): Promise<void> {
    await this.sandbox.commands.run(cmd, { background: true, timeoutMs: 0 });
  }

  async exposePort(port: number): Promise<ExposedPort> {
    return {
      url: `https://${this.sandbox.getHost(port)}`,
      authGatedByProvider: false,
    };
  }

  async setTimeout(timeoutMs: number): Promise<void> {
    await this.sandbox.setTimeout(timeoutMs);
  }

  async destroy(): Promise<void> {
    await E2bSandbox.kill(this.id);
  }
}

export class E2bSandboxProvider implements SandboxProvider {
  readonly name = "e2b";
  readonly capabilities: ReadonlySet<Capability> = new Set([
    "background-exec",
    "live-file-upload",
    "extend-timeout",
  ]);
  readonly instances: Record<string, E2bSandboxAdapter> = {};

  async create(opts: CreateOptions): Promise<Sandbox> {
    const sandbox = await E2bSandbox.create(opts.image, {
      envs: opts.envs,
      timeoutMs: opts.timeoutMs,
    });
    const adapter = new E2bSandboxAdapter(sandbox);
    this.instances[adapter.id] = adapter;
    return adapter;
  }

  async connect(id: string): Promise<Sandbox> {
    if (this.instances[id] !== undefined) return this.instances[id];
    const adapter = new E2bSandboxAdapter(await E2bSandbox.connect(id));
    this.instances[id] = adapter;
    return adapter;
  }

  async list(): Promise<SandboxInfo[]> {
    const sandboxes: SandboxInfo[] = [];
    const paginator = E2bSandbox.list();
    while (paginator.hasNext) {
      for (const sandbox of await paginator.nextItems()) {
        sandboxes.push({ id: sandbox.sandboxId, startedAt: sandbox.startedAt });
      }
    }
    return sandboxes;
  }

  async destroy(id: string): Promise<boolean> {
    return E2bSandbox.kill(id);
  }
}
