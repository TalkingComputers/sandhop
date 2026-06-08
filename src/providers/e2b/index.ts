import { createHash } from "node:crypto";
import type { HostDeps } from "../../core/ports/host.js";
import type {
  CreateOptions,
  ExecOptions,
  RunResult,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
  SandboxRuntime,
} from "../../core/ports/provider.js";
import {
  buildRuntimeMetadata,
  buildSandboxToolInstallScript,
  buildRuntimeEnv,
  buildRuntimeUserScript,
  readRuntimeMetadata,
  validateRuntime,
} from "../../core/sandbox-runtime.js";
import { toArrayBuffer } from "../encode.js";
import { requireCred } from "../index.js";
import { lazyImport, lazyOnce } from "../lazy-import.js";
import {
  createSandbox,
  renderCommandCall,
  renderDetachedShell,
  type SandboxOps,
} from "../sandbox-adapter.js";

type E2bModule = typeof import("e2b");
type E2bSandboxInstance = Awaited<ReturnType<E2bModule["Sandbox"]["create"]>>;

interface E2bCredentials {
  apiKey: string;
}

const UPLOAD_TIMEOUT_MS = 600000;
const PATH_UPLOAD_TIMEOUT_MS = 3_600_000;
const TEMPLATE_MEMORY_MB = 4096;
const TEMPLATE_CPU = 4;
const E2B_PACKAGE = "e2b";
const E2B_INSTALL_HINT =
  "The 'e2b' provider needs the 'e2b' package. Run: npm i e2b";
const loadE2b = lazyOnce(() =>
  lazyImport<E2bModule>(E2B_PACKAGE, E2B_INSTALL_HINT),
);

const templateName = (runtime: SandboxRuntime): string =>
  `sandhop-${createHash("sha256")
    .update(JSON.stringify(validateRuntime(runtime)))
    .digest("hex")
    .slice(0, 16)}`;

const buildSandhopTemplate = (
  Template: E2bModule["Template"],
  runtime: SandboxRuntime,
) =>
  Template()
    .fromBaseImage()
    .aptInstall(["ca-certificates", "curl", "tmux", "zstd", "util-linux"])
    .runCmd(buildRuntimeUserScript(runtime), { user: "root" })
    .setWorkdir(runtime.workdir)
    .setUser(runtime.username)
    .runCmd(buildSandboxToolInstallScript(), { user: "root" })
    .setWorkdir(runtime.workdir)
    .setUser(runtime.username);

const runCommand = async (
  e2b: E2bModule,
  sandbox: E2bSandboxInstance,
  cmd: string,
  runtime: SandboxRuntime,
  opts?: ExecOptions,
): Promise<RunResult> => {
  const timeoutMs = opts?.timeoutMs ?? UPLOAD_TIMEOUT_MS;
  try {
    const result = await sandbox.commands.run(cmd, {
      cwd: opts?.cwd ?? runtime.workdir,
      envs: { ...opts?.env, ...buildRuntimeEnv(runtime) },
      user: "root",
      timeoutMs,
      requestTimeoutMs: timeoutMs,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error: unknown) {
    if (error instanceof e2b.CommandExitError)
      return {
        exitCode: error.exitCode,
        stdout: error.stdout,
        stderr: error.stderr,
      };
    throw error;
  }
};

const makeOps = (
  e2b: E2bModule,
  sandbox: E2bSandboxInstance,
  runtime: SandboxRuntime,
  host: Pick<HostDeps, "openBlob">,
  credentials?: E2bCredentials,
): SandboxOps => ({
  uploadFile: async (path, data) => {
    await sandbox.files.write(path, toArrayBuffer(data), {
      requestTimeoutMs: UPLOAD_TIMEOUT_MS,
      user: runtime.username,
      useOctetStream: true,
    });
  },

  uploadPath: async (remotePath, localPath) => {
    await sandbox.files.write(remotePath, await host.openBlob(localPath), {
      requestTimeoutMs: PATH_UPLOAD_TIMEOUT_MS,
      user: runtime.username,
      useOctetStream: true,
    });
  },

  exec: (file, args, opts) =>
    runCommand(e2b, sandbox, renderCommandCall(file, args), runtime, opts),

  spawn: async (file, args, opts) => {
    const command =
      opts?.stdoutPath === undefined && opts?.stderrPath === undefined
        ? renderCommandCall(file, args)
        : renderDetachedShell(renderCommandCall(file, args), opts);
    await sandbox.commands.run(command, {
      background: true,
      cwd: opts?.cwd ?? runtime.workdir,
      envs: { ...opts?.env, ...buildRuntimeEnv(runtime) },
      timeoutMs: 0,
      user: runtime.username,
    });
  },

  exposePort: (port) =>
    Promise.resolve({ url: `https://${sandbox.getHost(port)}` }),

  destroy: async () => {
    await e2b.Sandbox.kill(sandbox.sandboxId, credentials);
  },
});

export class E2bSandboxProvider implements SandboxProvider {
  readonly name = "e2b";
  readonly host: Pick<HostDeps, "env" | "openBlob">;

  constructor(host: Pick<HostDeps, "env" | "openBlob">) {
    this.host = host;
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    const e2b = await loadE2b();
    const credentials = this.credentials();
    const runtime = validateRuntime(opts.runtime);
    const template = templateName(runtime);
    if (!(await e2b.Template.exists(template, credentials)))
      await e2b.Template.build(
        buildSandhopTemplate(e2b.Template, runtime),
        template,
        {
          ...credentials,
          cpuCount: TEMPLATE_CPU,
          memoryMB: TEMPLATE_MEMORY_MB,
        },
      );
    const sandbox = await e2b.Sandbox.create(template, {
      ...credentials,
      envs: { ...opts.envs, ...buildRuntimeEnv(runtime) },
      metadata: buildRuntimeMetadata(runtime),
      timeoutMs: opts.timeoutMs,
    });
    return createSandbox(
      sandbox.sandboxId,
      runtime,
      makeOps(e2b, sandbox, runtime, this.host, credentials),
    );
  }

  async connect(id: string): Promise<Sandbox> {
    const e2b = await loadE2b();
    const sandbox = await e2b.Sandbox.connect(id, this.credentials());
    const credentials = this.credentials();
    const runtime = readRuntimeMetadata((await sandbox.getInfo()).metadata);
    return createSandbox(
      id,
      runtime,
      makeOps(e2b, sandbox, runtime, this.host, credentials),
    );
  }

  async list(): Promise<SandboxInfo[]> {
    const e2b = await loadE2b();
    const sandboxes: SandboxInfo[] = [];
    const paginator = e2b.Sandbox.list(this.credentials());
    while (paginator.hasNext) {
      for (const sandbox of await paginator.nextItems()) {
        const startedAt =
          sandbox.startedAt instanceof Date
            ? sandbox.startedAt
            : new Date(sandbox.startedAt);
        if (Number.isNaN(startedAt.getTime()))
          throw new Error(
            `Invalid E2B sandbox startedAt: ${sandbox.sandboxId}`,
          );
        sandboxes.push({ id: sandbox.sandboxId, startedAt });
      }
    }
    return sandboxes;
  }

  async destroy(id: string): Promise<boolean> {
    const e2b = await loadE2b();
    return e2b.Sandbox.kill(id, this.credentials());
  }

  private credentials(): E2bCredentials {
    return { apiKey: requireCred(this.host, "e2b", "E2B_API_KEY") };
  }
}
