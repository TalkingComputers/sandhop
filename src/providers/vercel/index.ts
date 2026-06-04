import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { formatErrorText } from "../../core/errors.js";
import { dirname } from "../../core/paths.js";
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

type VercelModule = typeof import("@vercel/sandbox");
type VercelSdkSandbox = InstanceType<VercelModule["Sandbox"]>;
type VercelSandboxInstance = Omit<VercelSdkSandbox, "extendTimeout"> & {
  extendTimeout?: (duration: number) => Promise<void>;
};

interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

const VERCEL_INSTALL_HINT =
  "The 'vercel' provider needs @vercel/sandbox. Run: npm i @vercel/sandbox";
const LIST_LIMIT = 100;

const loadVercel = async (): Promise<VercelModule> => {
  try {
    return await import("@vercel/sandbox");
  } catch (error: unknown) {
    const text = formatErrorText(error);
    if (text.includes("Cannot find") && text.includes("@vercel/sandbox"))
      throw new Error(VERCEL_INSTALL_HINT);
    throw error;
  }
};

const sandboxName = (): string => `keepon-${randomUUID()}`;

class VercelSandboxAdapter implements Sandbox {
  readonly id: string;
  readonly sandbox: VercelSandboxInstance;
  readonly host: Pick<HostDeps, "readBytes">;
  readonly onDestroy: (id: string) => void;

  constructor(
    id: string,
    sandbox: VercelSandboxInstance,
    host: Pick<HostDeps, "readBytes">,
    onDestroy: (id: string) => void,
  ) {
    this.id = id;
    this.sandbox = sandbox;
    this.host = host;
    this.onDestroy = onDestroy;
  }

  async uploadFile(path: string, data: Uint8Array | string): Promise<void> {
    const dir = dirname(path);
    if (dir && dir !== "/") await this.sandbox.mkDir(dir).catch(() => {});
    await this.sandbox.writeFiles([
      {
        path,
        content:
          typeof data === "string" ? Buffer.from(data) : Buffer.from(data),
      },
    ]);
  }

  async uploadPath(remotePath: string, localPath: string): Promise<void> {
    await this.sandbox.writeFiles([
      {
        path: remotePath,
        content: Buffer.from(this.host.readBytes(localPath)),
      },
    ]);
  }

  async exec(cmd: string): Promise<RunResult> {
    const result = await this.sandbox.runCommand("bash", ["-lc", cmd]);
    return {
      exitCode: result.exitCode,
      stdout: await result.stdout(),
      stderr: await result.stderr(),
    };
  }

  async spawn(cmd: string): Promise<void> {
    await this.sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", cmd],
      detached: true,
    });
  }

  async exposePort(port: number): Promise<ExposedPort> {
    return { url: this.sandbox.domain(port), authGatedByProvider: false };
  }

  async setTimeout(timeoutMs: number): Promise<void> {
    if (this.sandbox.extendTimeout !== undefined) {
      await this.sandbox.extendTimeout(timeoutMs);
      return;
    }
    await this.sandbox.update({ timeout: timeoutMs });
  }

  async destroy(): Promise<void> {
    await this.sandbox.stop();
    this.onDestroy(this.id);
  }
}

export class VercelSandboxProvider implements SandboxProvider {
  readonly name = "vercel";
  readonly capabilities: ReadonlySet<Capability> = new Set([
    "background-exec",
    "live-file-upload",
    "extend-timeout",
  ]);
  readonly instances: Record<string, VercelSandboxAdapter> = {};
  readonly host: Pick<HostDeps, "env" | "readBytes">;

  constructor(host: Pick<HostDeps, "env" | "readBytes">) {
    this.host = host;
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    const credentials = this.credentials();
    const { Sandbox } = await loadVercel();
    const name = sandboxName();
    const sandbox = await Sandbox.create({
      ...credentials,
      name,
      timeout: opts.timeoutMs,
      ports: opts.ports ?? [7681],
      runtime: "node22",
    });
    return this.track(name, sandbox);
  }

  async connect(id: string): Promise<Sandbox> {
    if (this.instances[id] !== undefined) return this.instances[id];
    const credentials = this.credentials();
    const { Sandbox } = await loadVercel();
    return this.track(
      id,
      await Sandbox.get({ ...credentials, name: id, resume: true }),
    );
  }

  async list(): Promise<SandboxInfo[]> {
    const credentials = this.credentials();
    const { Sandbox } = await loadVercel();
    const sandboxes: SandboxInfo[] = [];
    for await (const sandbox of await Sandbox.list({
      ...credentials,
      limit: LIST_LIMIT,
    }))
      sandboxes.push({
        id: sandbox.name,
        startedAt: new Date(sandbox.createdAt),
      });
    return sandboxes;
  }

  async destroy(id: string): Promise<boolean> {
    if (this.instances[id] !== undefined) {
      await this.instances[id].destroy();
      delete this.instances[id];
      return true;
    }
    const credentials = this.credentials();
    const { Sandbox } = await loadVercel();
    await (await Sandbox.get({ ...credentials, name: id })).stop();
    return true;
  }

  private credentials(): VercelCredentials {
    const token = this.host.env.VERCEL_TOKEN;
    if (token === undefined)
      throw new Error("VERCEL_TOKEN is required for vercel provider");
    const teamId = this.host.env.VERCEL_TEAM_ID;
    if (teamId === undefined)
      throw new Error("VERCEL_TEAM_ID is required for vercel provider");
    const projectId = this.host.env.VERCEL_PROJECT_ID;
    if (projectId === undefined)
      throw new Error("VERCEL_PROJECT_ID is required for vercel provider");
    return { token, teamId, projectId };
  }

  private track(id: string, sandbox: VercelSandboxInstance): Sandbox {
    const adapter = new VercelSandboxAdapter(
      id,
      sandbox,
      this.host,
      (sandboxId) => {
        delete this.instances[sandboxId];
      },
    );
    this.instances[id] = adapter;
    return adapter;
  }
}
