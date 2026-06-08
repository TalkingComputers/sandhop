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
  readRuntimeMetadata,
  validateRuntime,
} from "../../core/sandbox-runtime.js";
import { destroyOrFalse } from "../destroy.js";
import { toBuffer } from "../encode.js";
import { requireCred } from "../index.js";
import { lazyImport, lazyOnce } from "../lazy-import.js";
import {
  createSandbox,
  renderDetachedShell,
  renderShellCall,
  type SandboxOps,
} from "../sandbox-adapter.js";
import { quote } from "shell-quote";

type VercelModule = typeof import("@vercel/sandbox");
type VercelSandboxInstance = InstanceType<VercelModule["Sandbox"]>;

interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

interface VercelHttpError extends Error {
  status?: number;
  statusCode?: number;
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

const isNotFoundError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const httpError = error as VercelHttpError;
  return httpError.status === 404 || httpError.statusCode === 404;
};

const readCommand = async (
  result: VercelCommandResult,
): Promise<RunResult> => ({
  exitCode: result.exitCode,
  stdout: await result.stdout(),
  stderr: await result.stderr(),
});

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
      timeoutMs,
    }),
  );

const runRootCommand = async (
  sandbox: VercelSandboxInstance,
  runtime: SandboxRuntime,
  file: string,
  args: readonly string[],
  opts:
    | {
        cwd?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
      }
    | undefined,
): Promise<RunResult> =>
  readCommand(
    await sandbox.runCommand({
      cmd: "env",
      args: [
        ...Object.entries({ ...opts?.env, ...buildRuntimeEnv(runtime) }).map(
          ([key, value]) => `${key}=${value}`,
        ),
        file,
        ...args,
      ],
      cwd: opts?.cwd ?? runtime.workdir,
      sudo: true,
      timeoutMs: opts?.timeoutMs ?? COMMAND_TIMEOUT_MS,
    }),
  );

const spawnRuntimeCommand = async (
  sandbox: VercelSandboxInstance,
  runtime: SandboxRuntime,
  script: string,
): Promise<void> => {
  await sandbox.runCommand({
    cmd: "runuser",
    args: buildRunuserArgs(runtime, script).slice(1),
    detached: true,
    sudo: true,
    timeoutMs: 0,
  });
};

const buildVercelRuntimeScript = (
  runtime: SandboxRuntime,
  file: string,
  args: readonly string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): string =>
  renderShellCall(file, args, {
    cwd: opts?.cwd ?? runtime.workdir,
    env: { ...opts?.env, ...buildRuntimeEnv(runtime) },
  });

const setupRuntime = async (
  sandbox: VercelSandboxInstance,
  runtime: SandboxRuntime,
  timeoutMs: number,
): Promise<void> => {
  const result = await runRootShell(
    sandbox,
    [
      "dnf install -y ca-certificates curl zstd tmux util-linux shadow-utils",
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
): SandboxOps => ({
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

  exec: async (file, args, opts) => {
    return runRootCommand(sandbox, runtime, file, args, opts);
  },

  spawn: async (file, args, opts) => {
    await spawnRuntimeCommand(
      sandbox,
      runtime,
      renderDetachedShell(
        buildVercelRuntimeScript(runtime, file, args, opts),
        opts,
      ),
    );
  },

  exposePort: (port) => Promise.resolve({ url: sandbox.domain(port) }),

  destroy: async () => {
    await sandbox.stop();
  },
});

export class VercelSandboxProvider implements SandboxProvider {
  readonly name = "vercel";
  readonly host: Pick<HostDeps, "env" | "readBytes">;
  private readonly sdk: () => Promise<VercelModule>;

  constructor(host: Pick<HostDeps, "env" | "readBytes">) {
    this.host = host;
    this.sdk = lazyOnce(() =>
      lazyImport<VercelModule>(VERCEL_PACKAGE, VERCEL_INSTALL_HINT),
    );
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    const credentials = this.credentials();
    const runtime = validateRuntime(opts.runtime);
    const { Sandbox } = await this.sdk();
    const name = sandboxName();
    const sandbox = await Sandbox.create({
      ...credentials,
      env: { ...opts.envs, ...buildRuntimeEnv(runtime) },
      name,
      persistent: false,
      timeout: opts.timeoutMs,
      ports: opts.ports,
      resources: { vcpus: VERCEL_SANDBOX_VCPUS },
      runtime: vercelRuntime(),
      tags: buildRuntimeMetadata(runtime),
    });
    await setupRuntime(sandbox, runtime, opts.timeoutMs);
    return createSandbox(name, runtime, makeOps(sandbox, this.host, runtime));
  }

  async connect(id: string): Promise<Sandbox> {
    const credentials = this.credentials();
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
    const credentials = this.credentials();
    const { Sandbox } = await this.sdk();
    const sandboxes: SandboxInfo[] = [];
    for await (const sandbox of await Sandbox.list(credentials)) {
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
    const credentials = this.credentials();
    const { Sandbox } = await this.sdk();
    return destroyOrFalse(isNotFoundError, async () => {
      await (await Sandbox.get({ ...credentials, name: id })).stop();
    });
  }

  private credentials(): VercelCredentials {
    return {
      token: requireCred(this.host, "vercel", "VERCEL_TOKEN"),
      teamId: requireCred(this.host, "vercel", "VERCEL_TEAM_ID"),
      projectId: requireCred(this.host, "vercel", "VERCEL_PROJECT_ID"),
    };
  }
}
