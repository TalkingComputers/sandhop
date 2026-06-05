import type { CreateSandboxBaseParams, DaytonaConfig } from "@daytonaio/sdk";
import type { HostDeps } from "../../core/ports/host.js";
import type {
  CreateOptions,
  ExecOptions,
  ExposedPort,
  RunResult,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
} from "../../core/ports/provider.js";
import { shellQuote } from "../../core/shell.js";
import { destroyOrFalse } from "../destroy.js";
import { toBuffer } from "../encode.js";
import { optionalCred, requireCred } from "../index.js";
import { lazyImport, lazyOnce } from "../lazy-import.js";

type DaytonaModule = typeof import("@daytonaio/sdk");
type DaytonaClient = InstanceType<DaytonaModule["Daytona"]>;

interface DaytonaProcess {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<{ exitCode: number; result: string }>;
}

interface DaytonaFileSystem {
  uploadFile(
    file: Buffer | string,
    remotePath: string,
    timeout?: number,
  ): Promise<void>;
}

interface DaytonaSandboxInstance {
  id: string;
  createdAt?: string;
  process: DaytonaProcess;
  fs: DaytonaFileSystem;
  getPreviewLink(port: number): Promise<{ url: string; token?: string }>;
  delete(timeout?: number): Promise<void>;
}

interface DaytonaCredentials {
  apiKey: string;
  apiUrl: string | undefined;
  target: string | undefined;
}

const COMMAND_TIMEOUT_SECONDS = 600;
const PATH_UPLOAD_TIMEOUT_SECONDS = 3600;

const DAYTONA_INSTALL_HINT =
  "The 'daytona' provider needs @daytonaio/sdk. Run: npm i @daytonaio/sdk";
const DAYTONA_PACKAGE = "@daytonaio/sdk";

const timeoutSeconds = (timeoutMs: number): number =>
  Math.ceil(timeoutMs / 1000);

const autoStopMinutes = (timeoutMs: number): number =>
  Math.max(1, Math.ceil(timeoutMs / 60000));

// daytona rejects `resources` on the default-snapshot path (HTTP 400); resources requires image-based create.
const buildCreateParams = (opts: CreateOptions): CreateSandboxBaseParams => ({
  autoStopInterval: autoStopMinutes(opts.timeoutMs),
  envVars: opts.envs,
  ephemeral: true,
});

class DaytonaSandboxAdapter implements Sandbox {
  readonly id: string;
  readonly home: string;
  readonly sandbox: DaytonaSandboxInstance;
  readonly timeoutSeconds: number;

  constructor(
    sandbox: DaytonaSandboxInstance,
    timeoutSecondsValue: number,
    home: string,
  ) {
    this.sandbox = sandbox;
    this.timeoutSeconds = timeoutSecondsValue;
    this.id = sandbox.id;
    this.home = home;
  }

  async uploadFile(path: string, data: Uint8Array | string): Promise<void> {
    await this.sandbox.fs.uploadFile(toBuffer(data), path, this.timeoutSeconds);
  }

  async uploadPath(remotePath: string, localPath: string): Promise<void> {
    await this.sandbox.fs.uploadFile(
      localPath,
      remotePath,
      PATH_UPLOAD_TIMEOUT_SECONDS,
    );
  }

  async exec(cmd: string, opts?: ExecOptions): Promise<RunResult> {
    const result = await this.sandbox.process.executeCommand(
      `bash -lc ${shellQuote(cmd)}`,
      undefined,
      undefined,
      opts?.timeoutMs === undefined
        ? COMMAND_TIMEOUT_SECONDS
        : timeoutSeconds(opts.timeoutMs),
    );
    return {
      exitCode: result.exitCode,
      stdout: result.result,
      stderr: result.result,
    };
  }

  async spawn(cmd: string): Promise<void> {
    await this.sandbox.process.executeCommand(
      `nohup bash -lc ${shellQuote(cmd)} >/dev/null 2>&1 &`,
      undefined,
      undefined,
      COMMAND_TIMEOUT_SECONDS,
    );
  }

  async exposePort(port: number): Promise<ExposedPort> {
    const preview = await this.sandbox.getPreviewLink(port);
    return { url: preview.url };
  }

  async destroy(): Promise<void> {
    await this.sandbox.delete(this.timeoutSeconds);
  }
}

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = "daytona";
  readonly host: Pick<HostDeps, "env">;
  private readonly client: () => Promise<DaytonaClient>;

  constructor(host: Pick<HostDeps, "env">) {
    this.host = host;
    this.client = lazyOnce(() => this.createClient());
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    const timeout = timeoutSeconds(opts.timeoutMs);
    const sandbox = (await (
      await this.client()
    ).create(buildCreateParams(opts), { timeout })) as DaytonaSandboxInstance;
    try {
      return new DaytonaSandboxAdapter(
        sandbox,
        timeout,
        await this.readHome(sandbox, timeout),
      );
    } catch (error: unknown) {
      await sandbox.delete(timeout).catch(() => undefined);
      throw error;
    }
  }

  async connect(id: string): Promise<Sandbox> {
    const sandbox = (await (
      await this.client()
    ).get(id)) as DaytonaSandboxInstance;
    return new DaytonaSandboxAdapter(
      sandbox,
      COMMAND_TIMEOUT_SECONDS,
      await this.readHome(sandbox, COMMAND_TIMEOUT_SECONDS),
    );
  }

  async list(): Promise<SandboxInfo[]> {
    const sandboxes: SandboxInfo[] = [];
    for await (const sandbox of (await this.client()).list()) {
      const instance = sandbox as DaytonaSandboxInstance;
      const startedAt =
        instance.createdAt === undefined
          ? new Date(0)
          : new Date(instance.createdAt);
      sandboxes.push({
        id: instance.id,
        startedAt: Number.isNaN(startedAt.getTime()) ? new Date(0) : startedAt,
      });
    }
    return sandboxes;
  }

  async destroy(id: string): Promise<boolean> {
    return destroyOrFalse(
      (error) =>
        error instanceof Error && error.name === "DaytonaNotFoundError",
      async () => {
        const sandbox = (await (
          await this.client()
        ).get(id)) as DaytonaSandboxInstance;
        await sandbox.delete(COMMAND_TIMEOUT_SECONDS);
      },
    );
  }

  private async createClient(): Promise<DaytonaClient> {
    const { Daytona } = await lazyImport<DaytonaModule>(
      DAYTONA_PACKAGE,
      DAYTONA_INSTALL_HINT,
    );
    const credentials: DaytonaCredentials = {
      apiKey: requireCred(this.host, "daytona", "DAYTONA_API_KEY"),
      apiUrl: optionalCred(this.host, "daytona", "DAYTONA_API_URL"),
      target: optionalCred(this.host, "daytona", "DAYTONA_TARGET"),
    };
    const config: DaytonaConfig = { apiKey: credentials.apiKey };
    if (credentials.apiUrl !== undefined) config.apiUrl = credentials.apiUrl;
    if (credentials.target !== undefined) config.target = credentials.target;
    return new Daytona(config);
  }

  private async readHome(
    sandbox: DaytonaSandboxInstance,
    timeout: number,
  ): Promise<string> {
    const result = await sandbox.process.executeCommand(
      `bash -lc ${shellQuote('printf %s "$HOME"')}`,
      undefined,
      undefined,
      timeout,
    );
    if (result.exitCode !== 0)
      throw new Error(`Home lookup failed: ${result.result}`);
    return result.result.trim();
  }
}
