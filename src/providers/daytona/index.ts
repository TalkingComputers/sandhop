import type {
  CreateSandboxFromImageParams,
  DaytonaConfig,
  Sandbox as DaytonaSandboxInstance,
} from "@daytona/sdk";
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
import { requireCred, type ResolvedCredentials } from "../index.js";
import { lazyImport, lazyOnce } from "../lazy-import.js";
import {
  createSandbox,
  renderServiceShell,
  renderShellCall,
  type ProviderOps,
} from "../sandbox-adapter.js";

type DaytonaModule = typeof import("@daytona/sdk");
type DaytonaClient = InstanceType<DaytonaModule["Daytona"]>;

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
const DAYTONA_NODE_IMAGE = "node:22-bookworm-slim";
const DAYTONA_SANDBOX_CPU_CORES = 4;
const DAYTONA_SANDBOX_MEMORY_GIB = 4;
const DAYTONA_SANDBOX_DISK_GIB = 10;

const timeoutSeconds = (timeoutMs: number): number =>
  Math.ceil(timeoutMs / 1000);

const autoStopMinutes = (timeoutMs: number): number =>
  Math.max(1, Math.ceil(timeoutMs / 60000));

const buildImage = (
  Image: DaytonaModule["Image"],
  runtime: SandboxRuntime,
): ReturnType<DaytonaModule["Image"]["base"]> =>
  Image.base(DAYTONA_NODE_IMAGE)
    .runCommands(
      "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends zstd tmux curl ca-certificates git jq unzip util-linux && rm -rf /var/lib/apt/lists/*",
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
  public: true,
  resources: {
    cpu: DAYTONA_SANDBOX_CPU_CORES,
    memory: DAYTONA_SANDBOX_MEMORY_GIB,
    disk: DAYTONA_SANDBOX_DISK_GIB,
  },
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
    if (
      result.exitCode === undefined ||
      result.stdout === undefined ||
      result.stderr === undefined
    )
      throw new Error(
        `Daytona session command returned an incomplete result: ${JSON.stringify(result)}`,
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

const makeOps = (
  sandbox: DaytonaSandboxInstance,
  runtime: SandboxRuntime,
  defaultTimeoutSeconds: number,
): ProviderOps => ({
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

  exec: (file, args, opts) =>
    execInSession(
      sandbox,
      renderShellCall(file, args, opts),
      timeoutSeconds(opts.timeoutMs),
    ),

  spawnService: async (service) => {
    const sessionId = `sandhop-service-${randomToken(12)}`;
    await sandbox.process.createSession(sessionId);
    await sandbox.process.executeSessionCommand(
      sessionId,
      {
        command: renderShellCall(
          "runuser",
          buildRunuserArgs(
            runtime,
            renderServiceShell(service, runtime.workdir),
          ).slice(1),
        ),
        runAsync: true,
        suppressInputEcho: true,
      },
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
  readonly credentials: DaytonaCredentials;
  private readonly sdk: () => Promise<DaytonaModule>;
  private readonly client: () => Promise<DaytonaClient>;

  constructor(credentials: ResolvedCredentials) {
    this.credentials = {
      apiKey: requireCred(credentials, "DAYTONA_API_KEY"),
      apiUrl: credentials["DAYTONA_API_URL"],
      target: credentials["DAYTONA_TARGET"],
    };
    this.sdk = lazyOnce(() =>
      lazyImport<DaytonaModule>(DAYTONA_PACKAGE, DAYTONA_INSTALL_HINT),
    );
    this.client = lazyOnce(() => this.createClient());
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    const runtime = validateRuntime(opts.runtime);
    const timeout = timeoutSeconds(opts.timeoutMs);
    const sandbox = await (
      await this.client()
    ).create(
      buildCreateParams((await this.sdk()).Image, { ...opts, runtime }),
      {
        timeout,
      },
    );
    return createSandbox(
      sandbox.id,
      runtime,
      makeOps(sandbox, runtime, timeout),
    );
  }

  async connect(id: string): Promise<Sandbox> {
    const sandbox = await (await this.client()).get(id);
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
      if (sandbox.createdAt === undefined)
        throw new Error(`Daytona sandbox createdAt missing: ${sandbox.id}`);
      const startedAt = new Date(sandbox.createdAt);
      if (Number.isNaN(startedAt.getTime()))
        throw new Error(`Invalid Daytona sandbox createdAt: ${sandbox.id}`);
      sandboxes.push({
        id: sandbox.id,
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
        const sandbox = await (await this.client()).get(id);
        await sandbox.delete(COMMAND_TIMEOUT_SECONDS);
      },
    );
  }

  private async createClient(): Promise<DaytonaClient> {
    const { Daytona } = await this.sdk();
    const config: DaytonaConfig = { apiKey: this.credentials.apiKey };
    if (this.credentials.apiUrl !== undefined)
      config.apiUrl = this.credentials.apiUrl;
    if (this.credentials.target !== undefined)
      config.target = this.credentials.target;
    return new Daytona(config);
  }
}
