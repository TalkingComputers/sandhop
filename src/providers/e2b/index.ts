import { CommandExitError, Sandbox as E2bSandbox } from "e2b";
import type { HostDeps } from "../../core/ports/host.js";
import type {
  CreateOptions,
  ExposedPort,
  RunResult,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
} from "../../core/ports/provider.js";
import { toArrayBuffer } from "../encode.js";

type E2bSandboxInstance = Awaited<ReturnType<typeof E2bSandbox.create>>;

const UPLOAD_TIMEOUT_MS = 600000;
const PATH_UPLOAD_TIMEOUT_MS = 3_600_000;

class E2bSandboxAdapter implements Sandbox {
  readonly id: string;
  readonly sandbox: E2bSandboxInstance;
  readonly host: Pick<HostDeps, "openBlob">;

  constructor(sandbox: E2bSandboxInstance, host: Pick<HostDeps, "openBlob">) {
    this.sandbox = sandbox;
    this.host = host;
    this.id = sandbox.sandboxId;
  }

  async uploadFile(path: string, data: Uint8Array | string): Promise<void> {
    await this.sandbox.files.write(path, toArrayBuffer(data), {
      requestTimeoutMs: UPLOAD_TIMEOUT_MS,
      useOctetStream: true,
    });
  }

  async uploadPath(remotePath: string, localPath: string): Promise<void> {
    await this.sandbox.files.write(
      remotePath,
      await this.host.openBlob(localPath),
      {
        requestTimeoutMs: PATH_UPLOAD_TIMEOUT_MS,
        useOctetStream: true,
      },
    );
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
    return { url: `https://${this.sandbox.getHost(port)}` };
  }

  async destroy(): Promise<void> {
    await E2bSandbox.kill(this.id);
  }
}

export class E2bSandboxProvider implements SandboxProvider {
  readonly name = "e2b";
  readonly host: Pick<HostDeps, "openBlob">;

  constructor(host: Pick<HostDeps, "openBlob">) {
    this.host = host;
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    const sandbox = await E2bSandbox.create(opts.image ?? "base", {
      envs: opts.envs,
      timeoutMs: opts.timeoutMs,
    });
    return new E2bSandboxAdapter(sandbox, this.host);
  }

  async connect(id: string): Promise<Sandbox> {
    return new E2bSandboxAdapter(await E2bSandbox.connect(id), this.host);
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
