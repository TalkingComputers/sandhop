import { randomUUID } from "node:crypto";
import { dirname } from "../../core/paths.js";
import type { HostDeps } from "../../core/ports/host.js";
import type {
  CreateOptions,
  ExposedPort,
  RunResult,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
} from "../../core/ports/provider.js";
import { toBuffer } from "../encode.js";
import { lazyImport, lazyOnce } from "../lazy-import.js";

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
const LIST_LIMIT = 100;

const sandboxName = (): string => `keepon-${randomUUID()}`;

const isNotFoundError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const httpError = error as VercelHttpError;
  return httpError.status === 404 || httpError.statusCode === 404;
};

class VercelSandboxAdapter implements Sandbox {
  readonly id: string;
  readonly sandbox: VercelSandboxInstance;
  readonly host: Pick<HostDeps, "readBytes">;

  constructor(
    id: string,
    sandbox: VercelSandboxInstance,
    host: Pick<HostDeps, "readBytes">,
  ) {
    this.id = id;
    this.sandbox = sandbox;
    this.host = host;
  }

  async uploadFile(path: string, data: Uint8Array | string): Promise<void> {
    const dir = dirname(path);
    if (dir && dir !== "/") await this.sandbox.mkDir(dir).catch(() => {});
    await this.sandbox.writeFiles([
      {
        path,
        content: toBuffer(data),
      },
    ]);
  }

  async uploadPath(remotePath: string, localPath: string): Promise<void> {
    await this.sandbox.writeFiles([
      {
        path: remotePath,
        content: toBuffer(this.host.readBytes(localPath)),
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
    return { url: this.sandbox.domain(port) };
  }

  async destroy(): Promise<void> {
    await this.sandbox.stop();
  }
}

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
      ports: opts.ports ?? [7681],
      runtime: "node22",
    });
    return new VercelSandboxAdapter(name, sandbox, this.host);
  }

  async connect(id: string): Promise<Sandbox> {
    const credentials = this.credentials();
    const { Sandbox } = await this.sdk();
    return new VercelSandboxAdapter(
      id,
      await Sandbox.get({ ...credentials, name: id, resume: true }),
      this.host,
    );
  }

  async list(): Promise<SandboxInfo[]> {
    const credentials = this.credentials();
    const { Sandbox } = await this.sdk();
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
    const credentials = this.credentials();
    const { Sandbox } = await this.sdk();
    try {
      await (await Sandbox.get({ ...credentials, name: id })).stop();
      return true;
    } catch (error: unknown) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  }

  private credentials(): VercelCredentials {
    const token = this.host.env["VERCEL_TOKEN"];
    if (token === undefined)
      throw new Error("VERCEL_TOKEN is required for vercel provider");
    const teamId = this.host.env["VERCEL_TEAM_ID"];
    if (teamId === undefined)
      throw new Error("VERCEL_TEAM_ID is required for vercel provider");
    const projectId = this.host.env["VERCEL_PROJECT_ID"];
    if (projectId === undefined)
      throw new Error("VERCEL_PROJECT_ID is required for vercel provider");
    return { token, teamId, projectId };
  }
}
