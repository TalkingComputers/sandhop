import { CommandExitError, Sandbox as E2bSandbox, Template } from "e2b";
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
import {
  GenericSandbox,
  readSandboxHome,
  type SandboxOps,
} from "../sandbox-adapter.js";

type E2bSandboxInstance = Awaited<ReturnType<typeof E2bSandbox.create>>;

interface E2bCredentials {
  apiKey: string;
}

const UPLOAD_TIMEOUT_MS = 600000;
const PATH_UPLOAD_TIMEOUT_MS = 3_600_000;
const SANDHOP_TEMPLATE = "sandhop";
const TEMPLATE_MEMORY_MB = 4096;
const TEMPLATE_CPU = 4;

const buildSandhopTemplate = () =>
  Template()
    .fromBaseImage()
    .aptInstall(["tmux", "zstd"])
    .runCmd(
      "curl -fsSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 -o /usr/local/bin/ttyd && chmod +x /usr/local/bin/ttyd",
      { user: "root" },
    );

const runCommand = async (
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
    if (error instanceof CommandExitError)
      return {
        exitCode: error.exitCode,
        stdout: error.stdout,
        stderr: error.stderr,
      };
    throw error;
  }
};

const makeOps = (
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

  exec: (cmd, opts) => runCommand(sandbox, cmd, opts),

  spawn: async (cmd) => {
    await sandbox.commands.run(cmd, { background: true, timeoutMs: 0 });
  },

  exposePort: (port) =>
    Promise.resolve({ url: `https://${sandbox.getHost(port)}` }),

  destroy: async () => {
    await E2bSandbox.kill(sandbox.sandboxId, credentials);
  },
});

export class E2bSandboxProvider implements SandboxProvider {
  readonly name = "e2b";
  readonly host: Pick<HostDeps, "env" | "openBlob">;

  constructor(host: Pick<HostDeps, "env" | "openBlob">) {
    this.host = host;
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    const credentials = this.credentials();
    if (!(await Template.exists(SANDHOP_TEMPLATE)))
      await Template.build(buildSandhopTemplate(), SANDHOP_TEMPLATE, {
        cpuCount: TEMPLATE_CPU,
        memoryMB: TEMPLATE_MEMORY_MB,
      });
    const sandbox = await E2bSandbox.create(SANDHOP_TEMPLATE, {
      ...credentials,
      envs: opts.envs,
      timeoutMs: opts.timeoutMs,
    });
    try {
      const ops = makeOps(sandbox, this.host, credentials);
      return new GenericSandbox(
        sandbox.sandboxId,
        await readSandboxHome(ops.exec),
        ops,
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
    const ops = makeOps(sandbox, this.host, this.credentials());
    return new GenericSandbox(id, await readSandboxHome(ops.exec), ops);
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
}
