import { randomUUID } from "node:crypto";
import { dirname } from "../../core/paths.js";
import type { HostDeps } from "../../core/ports/host.js";
import type {
  CreateOptions,
  RunResult,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
  SandboxRuntime,
} from "../../core/ports/provider.js";
import {
  buildRuntimeEnv,
  buildRuntimeMetadata,
  buildRuntimeUserScript,
  buildRunuserArgs,
  buildSandboxToolInstallScript,
  envPairs,
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
  type ProviderOps,
  type ResolvedExecOptions,
} from "../sandbox-adapter.js";
import { quote } from "shell-quote";

type VercelModule = typeof import("@vercel/sandbox");
type VercelSandboxInstance = InstanceType<VercelModule["Sandbox"]>;

interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

interface VercelApiError extends Error {
  response?: Pick<Response, "status">;
}

interface VercelCommandResult {
  exitCode: number;
  stdout(): Promise<string>;
  stderr(): Promise<string>;
}

const VERCEL_INSTALL_HINT =
  "The 'vercel' provider needs @vercel/sandbox. Run: npm i @vercel/sandbox";
const VERCEL_PACKAGE = "@vercel/sandbox";
const COMMAND_TIMEOUT_MS = 600000;
const VERCEL_MAX_SANDBOX_TIMEOUT_MS = 18_000_000;
const VERCEL_NODE_MAJORS = [22, 24, 26] as const;
const VERCEL_SANDBOX_VCPUS = 2;
type VercelNodeRuntime = `node${(typeof VERCEL_NODE_MAJORS)[number]}`;

const sandboxName = (): string => `sandhop-${randomUUID()}`;

const vercelRuntime = (): VercelNodeRuntime => {
  const major = Number(process.versions.node.split(".", 1)[0]);
  if (!Number.isInteger(major))
    throw new Error(`Invalid Node version ${process.versions.node}`);
  if (
    !VERCEL_NODE_MAJORS.includes(major as (typeof VERCEL_NODE_MAJORS)[number])
  )
    throw new Error(`Vercel Sandbox does not support Node ${major}`);
  return `node${major as (typeof VERCEL_NODE_MAJORS)[number]}`;
};

const isNotFoundError = (error: unknown): boolean =>
  error instanceof Error && (error as VercelApiError).response?.status === 404;

const readCommand = async (
  result: VercelCommandResult,
): Promise<RunResult> => ({
  exitCode: result.exitCode,
  stdout: await result.stdout(),
  stderr: await result.stderr(),
});

const clampTimeout = (timeoutMs: number): number =>
  Math.min(timeoutMs, VERCEL_MAX_SANDBOX_TIMEOUT_MS);

const runRootShell = async (
  sandbox: VercelSandboxInstance,
  script: string,
  timeoutMs: number,
): Promise<RunResult> =>
  readCommand(
    await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", script],
      sudo: true,
      timeoutMs: clampTimeout(timeoutMs),
    }),
  );

const runRootCommand = async (
  sandbox: VercelSandboxInstance,
  file: string,
  args: readonly string[],
  opts: ResolvedExecOptions,
): Promise<RunResult> =>
  readCommand(
    await sandbox.runCommand({
      cmd: "env",
      args: [...envPairs(opts.env), file, ...args],
      cwd: opts.cwd,
      sudo: true,
      timeoutMs: clampTimeout(opts.timeoutMs),
    }),
  );

const setupRuntime = async (
  sandbox: VercelSandboxInstance,
  runtime: SandboxRuntime,
  timeoutMs: number,
): Promise<void> => {
  const result = await runRootShell(
    sandbox,
    [
      "dnf install -y ca-certificates curl-minimal git jq unzip zstd tmux util-linux shadow-utils",
      buildRuntimeUserScript(runtime),
      buildSandboxToolInstallScript(),
    ].join(" && "),
    timeoutMs,
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Vercel runtime setup failed: ${result.stderr.length > 0 ? result.stderr : result.stdout}`,
    );
};

const installFile = async (
  sandbox: VercelSandboxInstance,
  runtime: SandboxRuntime,
  path: string,
  content: Buffer,
): Promise<void> => {
  const stage = `/tmp/sandhop-upload-${randomUUID()}`;
  await sandbox.writeFiles([{ path: stage, content }]);
  const result = await runRootShell(
    sandbox,
    [
      `mkdir -p ${quote([dirname(path)])}`,
      `mv -f ${quote([stage])} ${quote([path])}`,
      `chown ${quote([`${runtime.username}:${runtime.username}`])} ${quote([path])}`,
    ].join(" && "),
    COMMAND_TIMEOUT_MS,
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Vercel file install failed: ${result.stderr.length > 0 ? result.stderr : result.stdout}`,
    );
};

const makeOps = (
  sandbox: VercelSandboxInstance,
  host: Pick<HostDeps, "readBytes">,
  runtime: SandboxRuntime,
): ProviderOps => ({
  uploadFile: async (path, data) => {
    await installFile(sandbox, runtime, path, toBuffer(data));
  },

  uploadPath: async (remotePath, localPath) => {
    await installFile(
      sandbox,
      runtime,
      remotePath,
      toBuffer(host.readBytes(localPath)),
    );
  },

  exec: (file, args, opts) => runRootCommand(sandbox, file, args, opts),

  spawnService: async (service) => {
    await sandbox.runCommand({
      cmd: "runuser",
      args: buildRunuserArgs(runtime, renderServiceShell(service)).slice(1),
      cwd: runtime.workdir,
      detached: true,
      env: buildRuntimeEnv(runtime),
      sudo: true,
      timeoutMs: VERCEL_MAX_SANDBOX_TIMEOUT_MS,
    });
  },

  exposePort: (port) => Promise.resolve({ url: sandbox.domain(port) }),

  destroy: async () => {
    await sandbox.stop();
  },
});

export class VercelSandboxProvider implements SandboxProvider {
  readonly name = "vercel";
  readonly host: Pick<HostDeps, "readBytes">;
  readonly credentials: VercelCredentials;
  private readonly sdk: () => Promise<VercelModule>;

  constructor(
    host: Pick<HostDeps, "readBytes">,
    credentials: ResolvedCredentials,
  ) {
    this.host = host;
    this.credentials = {
      token: requireCred(credentials, "VERCEL_TOKEN"),
      teamId: requireCred(credentials, "VERCEL_TEAM_ID"),
      projectId: requireCred(credentials, "VERCEL_PROJECT_ID"),
    };
    this.sdk = lazyOnce(() =>
      lazyImport<VercelModule>(VERCEL_PACKAGE, VERCEL_INSTALL_HINT),
    );
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    const credentials = this.credentials;
    const runtime = validateRuntime(opts.runtime);
    const { Sandbox } = await this.sdk();
    const name = sandboxName();
    const sandbox = await Sandbox.create({
      ...credentials,
      env: { ...opts.envs, ...buildRuntimeEnv(runtime) },
      name,
      persistent: false,
      timeout: clampTimeout(opts.timeoutMs),
      ports: opts.ports,
      resources: { vcpus: VERCEL_SANDBOX_VCPUS },
      runtime: vercelRuntime(),
      tags: buildRuntimeMetadata(runtime),
    });
    try {
      await setupRuntime(sandbox, runtime, opts.timeoutMs);
    } catch (error: unknown) {
      await sandbox.stop();
      throw error;
    }
    return createSandbox(name, runtime, makeOps(sandbox, this.host, runtime));
  }

  async connect(id: string): Promise<Sandbox> {
    const credentials = this.credentials;
    const { Sandbox } = await this.sdk();
    const sandbox = await Sandbox.get({
      ...credentials,
      name: id,
      resume: true,
    });
    const runtime = readRuntimeMetadata(sandbox.tags);
    return createSandbox(id, runtime, makeOps(sandbox, this.host, runtime));
  }

  async list(): Promise<SandboxInfo[]> {
    const credentials = this.credentials;
    const { Sandbox } = await this.sdk();
    const sandboxes: SandboxInfo[] = [];
    for await (const sandbox of await Sandbox.list(credentials)) {
      if (sandbox.status !== "running" && sandbox.status !== "pending")
        continue;
      const startedAt = new Date(sandbox.createdAt);
      if (Number.isNaN(startedAt.getTime()))
        throw new Error(`Invalid Vercel sandbox createdAt: ${sandbox.name}`);
      sandboxes.push({
        id: sandbox.name,
        startedAt,
      });
    }
    return sandboxes;
  }

  async destroy(id: string): Promise<boolean> {
    const credentials = this.credentials;
    const { Sandbox } = await this.sdk();
    return destroyOrFalse(isNotFoundError, async () => {
      await (await Sandbox.get({ ...credentials, name: id })).stop();
    });
  }
}
