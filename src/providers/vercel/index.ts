import { randomUUID } from "node:crypto";
import { dirname } from "../../core/paths.js";
import type { HostDeps } from "../../core/ports/host.js";
import type {
  CreateOptions,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
} from "../../core/ports/provider.js";
import { destroyOrFalse } from "../destroy.js";
import { toBuffer } from "../encode.js";
import { requireCred } from "../index.js";
import { lazyImport, lazyOnce } from "../lazy-import.js";
import {
  GenericSandbox,
  readSandboxHome,
  type SandboxOps,
} from "../sandbox-adapter.js";

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
  let nearest: (typeof VERCEL_NODE_MAJORS)[number] = VERCEL_NODE_MAJORS[0];
  for (const candidate of VERCEL_NODE_MAJORS)
    if (Math.abs(candidate - major) < Math.abs(nearest - major))
      nearest = candidate;
  return `node${nearest}`;
};

const isNotFoundError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const httpError = error as VercelHttpError;
  return httpError.status === 404 || httpError.statusCode === 404;
};

const makeOps = (
  sandbox: VercelSandboxInstance,
  host: Pick<HostDeps, "readBytes">,
): SandboxOps => ({
  uploadFile: async (path, data) => {
    const dir = dirname(path);
    if (dir && dir !== "/") await sandbox.mkDir(dir).catch(() => {});
    await sandbox.writeFiles([
      {
        path,
        content: toBuffer(data),
      },
    ]);
  },

  uploadPath: async (remotePath, localPath) => {
    await sandbox.writeFiles([
      {
        path: remotePath,
        content: toBuffer(host.readBytes(localPath)),
      },
    ]);
  },

  exec: async (cmd, opts) => {
    const result = await sandbox.runCommand("bash", ["-lc", cmd], {
      timeoutMs: opts?.timeoutMs ?? COMMAND_TIMEOUT_MS,
    });
    return {
      exitCode: result.exitCode,
      stdout: await result.stdout(),
      stderr: await result.stderr(),
    };
  },

  spawn: async (cmd) => {
    await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", cmd],
      detached: true,
      timeoutMs: 0,
    });
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
    const { Sandbox } = await this.sdk();
    const name = sandboxName();
    const sandbox = await Sandbox.create({
      ...credentials,
      name,
      timeout: opts.timeoutMs,
      ports: opts.ports,
      resources: { vcpus: VERCEL_SANDBOX_VCPUS },
      runtime: vercelRuntime(),
    });
    try {
      const ops = makeOps(sandbox, this.host);
      return new GenericSandbox(name, await readSandboxHome(ops.exec), ops);
    } catch (error: unknown) {
      await sandbox.stop().catch(() => undefined);
      throw error;
    }
  }

  async connect(id: string): Promise<Sandbox> {
    const credentials = this.credentials();
    const { Sandbox } = await this.sdk();
    const sandbox = await Sandbox.get({
      ...credentials,
      name: id,
      resume: true,
    });
    const ops = makeOps(sandbox, this.host);
    return new GenericSandbox(id, await readSandboxHome(ops.exec), ops);
  }

  async list(): Promise<SandboxInfo[]> {
    const credentials = this.credentials();
    const { Sandbox } = await this.sdk();
    const sandboxes: SandboxInfo[] = [];
    for await (const sandbox of await Sandbox.list(credentials)) {
      const startedAt = new Date(sandbox.createdAt);
      sandboxes.push({
        id: sandbox.name,
        startedAt: Number.isNaN(startedAt.getTime()) ? new Date(0) : startedAt,
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
