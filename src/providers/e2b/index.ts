import type { HostDeps } from "../../core/ports/host.js";
import type {
  CreateOptions,
  ExecOptions,
  RunResult,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
} from "../../core/ports/provider.js";
import { toArrayBuffer } from "../encode.js";
import { requireCred } from "../index.js";
import { lazyImport, lazyOnce } from "../lazy-import.js";
import {
  createSandbox,
  readSandboxHome,
  renderDetachedShell,
  renderShellCall,
  type SandboxOps,
} from "../sandbox-adapter.js";

type E2bModule = typeof import("e2b");
type E2bSandboxInstance = Awaited<ReturnType<E2bModule["Sandbox"]["create"]>>;

interface E2bCredentials {
  apiKey: string;
}

const UPLOAD_TIMEOUT_MS = 600000;
const PATH_UPLOAD_TIMEOUT_MS = 3_600_000;
const SANDHOP_TEMPLATE = "sandhop";
const TEMPLATE_MEMORY_MB = 4096;
const TEMPLATE_CPU = 4;
const E2B_PACKAGE = "e2b";
const E2B_INSTALL_HINT =
  "The 'e2b' provider needs the 'e2b' package. Run: npm i e2b";
const loadE2b = lazyOnce(() =>
  lazyImport<E2bModule>(E2B_PACKAGE, E2B_INSTALL_HINT),
);

const buildSandhopTemplate = (Template: E2bModule["Template"]) =>
  Template()
    .fromBaseImage()
    .aptInstall(["tmux", "zstd"])
    .runCmd(
      "curl -fsSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 -o /usr/local/bin/ttyd && chmod +x /usr/local/bin/ttyd",
      { user: "root" },
    );

const runCommand = async (
  e2b: E2bModule,
  sandbox: E2bSandboxInstance,
  cmd: string,
  opts?: ExecOptions,
): Promise<RunResult> => {
  const timeoutMs = opts?.timeoutMs ?? UPLOAD_TIMEOUT_MS;
  try {
    const result = await sandbox.commands.run(cmd, {
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
  host: Pick<HostDeps, "openBlob">,
  credentials?: E2bCredentials,
): SandboxOps => ({
  uploadFile: async (path, data) => {
    await sandbox.files.write(path, toArrayBuffer(data), {
      requestTimeoutMs: UPLOAD_TIMEOUT_MS,
      useOctetStream: true,
    });
  },

  uploadPath: async (remotePath, localPath) => {
    await sandbox.files.write(remotePath, await host.openBlob(localPath), {
      requestTimeoutMs: PATH_UPLOAD_TIMEOUT_MS,
      useOctetStream: true,
    });
  },

  exec: (file, args, opts) =>
    runCommand(e2b, sandbox, renderShellCall(file, args, opts), opts),

  spawn: async (file, args, opts) => {
    const command =
      opts?.stdoutPath === undefined && opts?.stderrPath === undefined
        ? renderShellCall(file, args, opts)
        : renderDetachedShell(renderShellCall(file, args, opts), opts);
    await sandbox.commands.run(command, { background: true, timeoutMs: 0 });
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
    if (!(await e2b.Template.exists(SANDHOP_TEMPLATE)))
      await e2b.Template.build(
        buildSandhopTemplate(e2b.Template),
        SANDHOP_TEMPLATE,
        {
          cpuCount: TEMPLATE_CPU,
          memoryMB: TEMPLATE_MEMORY_MB,
        },
      );
    const sandbox = await e2b.Sandbox.create(SANDHOP_TEMPLATE, {
      ...credentials,
      envs: opts.envs,
      timeoutMs: opts.timeoutMs,
    });
    try {
      const ops = makeOps(e2b, sandbox, this.host, credentials);
      return createSandbox(
        sandbox.sandboxId,
        await readSandboxHome(ops.exec),
        ops,
      );
    } catch (error: unknown) {
      await e2b.Sandbox.kill(sandbox.sandboxId, credentials).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async connect(id: string): Promise<Sandbox> {
    const e2b = await loadE2b();
    const sandbox = await e2b.Sandbox.connect(id, this.credentials());
    const ops = makeOps(e2b, sandbox, this.host, this.credentials());
    return createSandbox(id, await readSandboxHome(ops.exec), ops);
  }

  async list(): Promise<SandboxInfo[]> {
    const e2b = await loadE2b();
    const sandboxes: SandboxInfo[] = [];
    const paginator = e2b.Sandbox.list(this.credentials());
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
    const e2b = await loadE2b();
    return e2b.Sandbox.kill(id, this.credentials());
  }

  private credentials(): E2bCredentials {
    return { apiKey: requireCred(this.host, "e2b", "E2B_API_KEY") };
  }
}
