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
import { requireCred } from "../index.js";

type E2bSandboxInstance = Awaited<ReturnType<typeof E2bSandbox.create>>;

interface E2bCredentials {
  apiKey: string;
}

const UPLOAD_TIMEOUT_MS = 600000;
const PATH_UPLOAD_TIMEOUT_MS = 3_600_000;

class E2bSandboxAdapter implements Sandbox {
  readonly id: string;
  readonly home: string;
  readonly sandbox: E2bSandboxInstance;
  readonly host: Pick<HostDeps, "openBlob">;

  constructor(
    sandbox: E2bSandboxInstance,
    host: Pick<HostDeps, "openBlob">,
    home: string,
  ) {
    this.sandbox = sandbox;
    this.host = host;
    this.id = sandbox.sandboxId;
    this.home = home;
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
  readonly host: Pick<HostDeps, "env" | "openBlob">;

  constructor(host: Pick<HostDeps, "env" | "openBlob">) {
    this.host = host;
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    const credentials = this.credentials();
    const sandbox = await E2bSandbox.create("base", {
      ...credentials,
      envs: opts.envs,
      timeoutMs: opts.timeoutMs,
    });
    try {
      return new E2bSandboxAdapter(
        sandbox,
        this.host,
        await this.readHome(sandbox),
      );
    } catch (error: unknown) {
      await E2bSandbox.kill(sandbox.sandboxId, credentials).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async connect(id: string): Promise<Sandbox> {
    const sandbox = await E2bSandbox.connect(id, this.credentials());
    return new E2bSandboxAdapter(
      sandbox,
      this.host,
      await this.readHome(sandbox),
    );
  }

  async list(): Promise<SandboxInfo[]> {
    const sandboxes: SandboxInfo[] = [];
    const paginator = E2bSandbox.list(this.credentials());
    while (paginator.hasNext) {
      for (const sandbox of await paginator.nextItems()) {
        const startedAt =
          sandbox.startedAt instanceof Date &&
          !Number.isNaN(sandbox.startedAt.getTime())
            ? sandbox.startedAt
            : new Date(0);
        sandboxes.push({ id: sandbox.sandboxId, startedAt });
      }
    }
    return sandboxes;
  }

  async destroy(id: string): Promise<boolean> {
    return E2bSandbox.kill(id, this.credentials());
  }

  private credentials(): E2bCredentials {
    return { apiKey: requireCred(this.host, "e2b", "E2B_API_KEY") };
  }

  private async readHome(sandbox: E2bSandboxInstance): Promise<string> {
    let result: { exitCode: number; stdout: string; stderr: string };
    try {
      result = await sandbox.commands.run('printf %s "$HOME"', {
        timeoutMs: UPLOAD_TIMEOUT_MS,
        requestTimeoutMs: UPLOAD_TIMEOUT_MS,
      });
    } catch (error: unknown) {
      if (error instanceof CommandExitError) {
        const output = error.stderr.length > 0 ? error.stderr : error.stdout;
        throw new Error(`Home lookup failed: ${output}`);
      }
      throw error;
    }
    if (result.exitCode !== 0) {
      const output = result.stderr.length > 0 ? result.stderr : result.stdout;
      throw new Error(`Home lookup failed: ${output}`);
    }
    const home = result.stdout.trim();
    if (home.length === 0) throw new Error("Home lookup returned empty path");
    return home;
  }
}
