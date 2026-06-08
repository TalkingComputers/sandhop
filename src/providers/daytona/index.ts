import type { CreateSandboxFromImageParams, DaytonaConfig } from "@daytona/sdk";
import type { HostDeps } from "../../core/ports/host.js";
import type {
  CreateOptions,
  RunResult,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
  SandboxRuntime,
} from "../../core/ports/provider.js";
import { randomToken } from "../../core/rand.js";
import {
  buildRuntimeEnv,
  buildRuntimeMetadata,
  buildRuntimeUserScript,
  buildRunuserArgs,
  buildSandboxToolInstallScript,
  readRuntimeMetadata,
  validateRuntime,
} from "../../core/sandbox-runtime.js";
import { destroyOrFalse } from "../destroy.js";
import { toBuffer } from "../encode.js";
import { optionalCred, requireCred } from "../index.js";
import { lazyImport, lazyOnce } from "../lazy-import.js";
import {
  createSandbox,
  renderDetachedShell,
  renderShellCall,
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
  labels: Record<string, string>;
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
  "The 'daytona' provider needs @daytona/sdk. Run: npm i @daytona/sdk";
const DAYTONA_PACKAGE = "@daytona/sdk";

const timeoutSeconds = (timeoutMs: number): number =>
  Math.ceil(timeoutMs / 1000);

const autoStopMinutes = (timeoutMs: number): number =>
  Math.max(1, Math.ceil(timeoutMs / 60000));

const buildImage = (
  Image: DaytonaModule["Image"],
  runtime: SandboxRuntime,
): ReturnType<DaytonaModule["Image"]["debianSlim"]> =>
  Image.debianSlim("3.13")
    .runCommands(
      "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends zstd tmux curl ca-certificates util-linux && rm -rf /var/lib/apt/lists/*",
      buildRuntimeUserScript(runtime),
      buildSandboxToolInstallScript(),
    )
    .env(buildRuntimeEnv(runtime))
    .workdir(runtime.workdir);

const buildCreateParams = (
  Image: DaytonaModule["Image"],
  opts: CreateOptions,
): CreateSandboxFromImageParams => ({
  autoStopInterval: autoStopMinutes(opts.timeoutMs),
  envVars: { ...opts.envs, ...buildRuntimeEnv(opts.runtime) },
  ephemeral: true,
  image: buildImage(Image, opts.runtime),
  labels: buildRuntimeMetadata(opts.runtime),
  user: "root",
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
        command: renderShellCall("bash", ["-lc", cmd]),
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
    await sandbox.process.deleteSession(sessionId);
  }
};

const scriptForCommand = (
  file: string,
  args: readonly string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): string =>
  file === "bash" && args[0] === "-lc" && args[1] !== undefined
    ? args[1]
    : renderShellCall(file, args, opts);

const makeOps = (
  sandbox: DaytonaSandboxInstance,
  runtime: SandboxRuntime,
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

  exec: async (file, args, opts) => {
    return execInSession(
      sandbox,
      scriptForCommand(file, args, {
        cwd: opts?.cwd ?? runtime.workdir,
        env: { ...opts?.env, ...buildRuntimeEnv(runtime) },
      }),
      opts?.timeoutMs === undefined
        ? COMMAND_TIMEOUT_SECONDS
        : timeoutSeconds(opts.timeoutMs),
    );
  },

  spawn: async (file, args, opts) => {
    const script = renderDetachedShell(renderShellCall(file, args, opts), opts);
    await sandbox.process.executeCommand(
      renderShellCall("runuser", buildRunuserArgs(runtime, script).slice(1)),
      runtime.workdir,
      buildRuntimeEnv(runtime),
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
  private readonly sdk: () => Promise<DaytonaModule>;
  private readonly client: () => Promise<DaytonaClient>;

  constructor(host: Pick<HostDeps, "env">) {
    this.host = host;
    this.sdk = lazyOnce(() =>
      lazyImport<DaytonaModule>(DAYTONA_PACKAGE, DAYTONA_INSTALL_HINT),
    );
    this.client = lazyOnce(() => this.createClient());
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    const runtime = validateRuntime(opts.runtime);
    const timeout = timeoutSeconds(opts.timeoutMs);
    const sandbox = (await (
      await this.client()
    ).create(
      buildCreateParams((await this.sdk()).Image, { ...opts, runtime }),
      {
        timeout,
      },
    )) as DaytonaSandboxInstance;
    return createSandbox(
      sandbox.id,
      runtime,
      makeOps(sandbox, runtime, timeout),
    );
  }

  async connect(id: string): Promise<Sandbox> {
    const sandbox = (await (
      await this.client()
    ).get(id)) as DaytonaSandboxInstance;
    const runtime = readRuntimeMetadata(sandbox.labels);
    return createSandbox(
      id,
      runtime,
      makeOps(sandbox, runtime, COMMAND_TIMEOUT_SECONDS),
    );
  }

  async list(): Promise<SandboxInfo[]> {
    const sandboxes: SandboxInfo[] = [];
    for await (const sandbox of (await this.client()).list()) {
      const instance = sandbox as DaytonaSandboxInstance;
      if (instance.createdAt === undefined)
        throw new Error(`Daytona sandbox createdAt missing: ${instance.id}`);
      const startedAt = new Date(instance.createdAt);
      if (Number.isNaN(startedAt.getTime()))
        throw new Error(`Invalid Daytona sandbox createdAt: ${instance.id}`);
      sandboxes.push({
        id: instance.id,
        startedAt,
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
    const { Daytona } = await this.sdk();
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
