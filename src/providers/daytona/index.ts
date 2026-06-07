import type { CreateSandboxBaseParams, DaytonaConfig } from "@daytona/sdk";
import type { HostDeps } from "../../core/ports/host.js";
import type {
  CreateOptions,
  RunResult,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
} from "../../core/ports/provider.js";
import { randomToken } from "../../core/rand.js";
import { shellQuote } from "../../core/shell.js";
import { destroyOrFalse } from "../destroy.js";
import { toBuffer } from "../encode.js";
import { optionalCred, requireCred } from "../index.js";
import { lazyImport, lazyOnce } from "../lazy-import.js";
import {
  GenericSandbox,
  readSandboxHome,
  type SandboxOps,
} from "../sandbox-adapter.js";

type DaytonaModule = typeof import("@daytona/sdk");
type DaytonaClient = InstanceType<DaytonaModule["Daytona"]>;

interface DaytonaProcess {
  createSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<{ exitCode: number; result: string }>;
  executeSessionCommand(
    sessionId: string,
    req: {
      command: string;
      runAsync: false;
      suppressInputEcho: true;
    },
    timeout?: number,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
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
const ZSTD_INSTALL = "apt-get update && apt-get install -y zstd";

const DAYTONA_INSTALL_HINT =
  "The 'daytona' provider needs @daytona/sdk. Run: npm i @daytona/sdk";
const DAYTONA_PACKAGE = "@daytona/sdk";

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

const execInSession = async (
  sandbox: DaytonaSandboxInstance,
  cmd: string,
  timeout: number,
): Promise<RunResult> => {
  const sessionId = `sandhop-exec-${randomToken(12)}`;
  await sandbox.process.createSession(sessionId);
  try {
    const result = await sandbox.process.executeSessionCommand(
      sessionId,
      {
        command: `bash -lc ${shellQuote(cmd)}`,
        runAsync: false,
        suppressInputEcho: true,
      },
      timeout,
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    await sandbox.process.deleteSession(sessionId).catch(() => undefined);
  }
};

const makeOps = (
  sandbox: DaytonaSandboxInstance,
  defaultTimeoutSeconds: number,
): SandboxOps => ({
  uploadFile: async (path, data) => {
    await sandbox.fs.uploadFile(toBuffer(data), path, defaultTimeoutSeconds);
  },

  uploadPath: async (remotePath, localPath) => {
    await sandbox.fs.uploadFile(
      localPath,
      remotePath,
      PATH_UPLOAD_TIMEOUT_SECONDS,
    );
  },

  exec: async (cmd, opts) => {
    return execInSession(
      sandbox,
      cmd,
      opts?.timeoutMs === undefined
        ? COMMAND_TIMEOUT_SECONDS
        : timeoutSeconds(opts.timeoutMs),
    );
  },

  spawn: async (cmd) => {
    await sandbox.process.executeCommand(
      `nohup bash -lc ${shellQuote(cmd)} >/dev/null 2>&1 &`,
      undefined,
      undefined,
      COMMAND_TIMEOUT_SECONDS,
    );
  },

  exposePort: async (port) => {
    const preview = await sandbox.getPreviewLink(port);
    return { url: preview.url };
  },

  destroy: async () => {
    await sandbox.delete(defaultTimeoutSeconds);
  },
});

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
      const ops = makeOps(sandbox, timeout);
      const home = await readSandboxHome(ops.exec);
      await ops.exec(ZSTD_INSTALL, { timeoutMs: opts.timeoutMs });
      return new GenericSandbox(sandbox.id, home, ops);
    } catch (error: unknown) {
      await sandbox.delete(timeout).catch(() => undefined);
      throw error;
    }
  }

  async connect(id: string): Promise<Sandbox> {
    const sandbox = (await (
      await this.client()
    ).get(id)) as DaytonaSandboxInstance;
    const ops = makeOps(sandbox, COMMAND_TIMEOUT_SECONDS);
    const home = await readSandboxHome(ops.exec);
    await ops.exec(ZSTD_INSTALL);
    return new GenericSandbox(id, home, ops);
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
}
