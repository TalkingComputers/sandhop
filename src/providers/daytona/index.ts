import { Buffer } from "node:buffer";
import type {
  CreateSandboxBaseParams,
  CreateSandboxFromImageParams,
  DaytonaConfig,
} from "@daytonaio/sdk";
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
import { shellQuote } from "../../core/shell.js";
import { lazyImport } from "../lazy-import.js";

type DaytonaModule = typeof import("@daytonaio/sdk");
type DaytonaClient = InstanceType<DaytonaModule["Daytona"]>;

interface DaytonaProcess {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<{ exitCode: number; result: string }>;
  createSession(sessionId: string): Promise<void>;
  executeSessionCommand(
    sessionId: string,
    req: { command: string; runAsync: boolean },
    timeout?: number,
  ): Promise<unknown>;
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

type DaytonaCreateParams =
  | CreateSandboxBaseParams
  | CreateSandboxFromImageParams;

const COMMAND_TIMEOUT_SECONDS = 600;
const PATH_UPLOAD_TIMEOUT_SECONDS = 3600;
const SESSION_ID = "keepon";

const DAYTONA_INSTALL_HINT =
  "The 'daytona' provider needs @daytonaio/sdk. Run: npm i @daytonaio/sdk";
const DAYTONA_PACKAGE = "@daytonaio/sdk";

const timeoutSeconds = (timeoutMs: number): number =>
  Math.ceil(timeoutMs / 1000);

const autoStopMinutes = (timeoutMs: number): number =>
  Math.max(1, Math.ceil(timeoutMs / 60000));

const buildCreateParams = (opts: CreateOptions): DaytonaCreateParams => {
  const base: CreateSandboxBaseParams = {
    autoStopInterval: autoStopMinutes(opts.timeoutMs),
    envVars: opts.envs,
    ephemeral: true,
  };
  if (opts.image === undefined) return base;
  return { ...base, image: opts.image };
};

class DaytonaSandboxAdapter implements Sandbox {
  readonly id: string;
  readonly sandbox: DaytonaSandboxInstance;
  readonly timeoutSeconds: number;
  hasSession: boolean;

  constructor(sandbox: DaytonaSandboxInstance, timeoutSecondsValue: number) {
    this.sandbox = sandbox;
    this.timeoutSeconds = timeoutSecondsValue;
    this.id = sandbox.id;
    this.hasSession = false;
  }

  async uploadFile(path: string, data: Uint8Array | string): Promise<void> {
    await this.sandbox.fs.uploadFile(
      typeof data === "string" ? Buffer.from(data) : Buffer.from(data),
      path,
      this.timeoutSeconds,
    );
  }

  async uploadPath(remotePath: string, localPath: string): Promise<void> {
    await this.sandbox.fs.uploadFile(
      localPath,
      remotePath,
      PATH_UPLOAD_TIMEOUT_SECONDS,
    );
  }

  async exec(cmd: string): Promise<RunResult> {
    const result = await this.sandbox.process.executeCommand(
      `bash -lc ${shellQuote(cmd)}`,
      undefined,
      undefined,
      this.timeoutSeconds,
    );
    return { exitCode: result.exitCode, stdout: result.result, stderr: "" };
  }

  async spawn(cmd: string): Promise<void> {
    if (!this.hasSession) {
      await this.sandbox.process.createSession(SESSION_ID);
      this.hasSession = true;
    }
    await this.sandbox.process.executeSessionCommand(SESSION_ID, {
      command: cmd,
      runAsync: true,
    });
  }

  async exposePort(port: number): Promise<ExposedPort> {
    const preview = await this.sandbox.getPreviewLink(port);
    return {
      url: preview.url,
      token: preview.token,
      authGatedByProvider: false,
    };
  }

  async setTimeout(timeoutMs: number): Promise<void> {
    timeoutMs;
  }

  async destroy(): Promise<void> {
    await this.sandbox.delete(this.timeoutSeconds);
  }
}

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = "daytona";
  readonly capabilities: ReadonlySet<Capability> = new Set([
    "background-exec",
    "live-file-upload",
  ]);
  readonly host: Pick<HostDeps, "env">;

  constructor(host: Pick<HostDeps, "env">) {
    this.host = host;
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    const timeout = timeoutSeconds(opts.timeoutMs);
    const sandbox = (await (
      await this.client()
    ).create(buildCreateParams(opts), { timeout })) as DaytonaSandboxInstance;
    return new DaytonaSandboxAdapter(sandbox, timeout);
  }

  async connect(id: string): Promise<Sandbox> {
    const sandbox = (await (
      await this.client()
    ).get(id)) as DaytonaSandboxInstance;
    return new DaytonaSandboxAdapter(sandbox, COMMAND_TIMEOUT_SECONDS);
  }

  async list(): Promise<SandboxInfo[]> {
    const sandboxes: SandboxInfo[] = [];
    for await (const sandbox of (await this.client()).list()) {
      const instance = sandbox as DaytonaSandboxInstance;
      sandboxes.push({
        id: instance.id,
        startedAt:
          instance.createdAt === undefined
            ? new Date(0)
            : new Date(instance.createdAt),
      });
    }
    return sandboxes;
  }

  async destroy(id: string): Promise<boolean> {
    try {
      const sandbox = (await (
        await this.client()
      ).get(id)) as DaytonaSandboxInstance;
      await sandbox.delete(COMMAND_TIMEOUT_SECONDS);
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "DaytonaNotFoundError")
        return false;
      throw error;
    }
  }

  private async client(): Promise<DaytonaClient> {
    const { Daytona } = await lazyImport<DaytonaModule>(
      DAYTONA_PACKAGE,
      DAYTONA_INSTALL_HINT,
    );
    const apiKey = this.host.env.DAYTONA_API_KEY;
    if (apiKey === undefined)
      throw new Error("DAYTONA_API_KEY is required for daytona provider");
    const config: DaytonaConfig = { apiKey };
    const apiUrl = this.host.env.DAYTONA_API_URL;
    if (apiUrl !== undefined) config.apiUrl = apiUrl;
    const target = this.host.env.DAYTONA_TARGET;
    if (target !== undefined) config.target = target;
    return new Daytona(config);
  }
}
