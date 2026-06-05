import { randomUUID } from "node:crypto";
import { TTYD_PORT } from "../../core/constants.js";
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
import { destroyOrFalse } from "../destroy.js";
import { toBuffer } from "../encode.js";
import { requireCred } from "../index.js";
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

const sandboxName = (): string => `sandhop-${randomUUID()}`;

const isNotFoundError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const httpError = error as VercelHttpError;
  return httpError.status === 404 || httpError.statusCode === 404;
};

class VercelSandboxAdapter implements Sandbox {
  readonly id: string;
  readonly home: string;
  readonly sandbox: VercelSandboxInstance;
  readonly host: Pick<HostDeps, "readBytes">;

  constructor(
    id: string,
    sandbox: VercelSandboxInstance,
    host: Pick<HostDeps, "readBytes">,
    home: string,
  ) {
    this.id = id;
    this.sandbox = sandbox;
    this.host = host;
    this.home = home;
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
      ports: opts.ports ?? [TTYD_PORT],
      runtime: "node22",
    });
    return new VercelSandboxAdapter(
      name,
      sandbox,
      this.host,
      await this.readHome(sandbox),
    );
  }

  async connect(id: string): Promise<Sandbox> {
    const credentials = this.credentials();
    const { Sandbox } = await this.sdk();
    const sandbox = await Sandbox.get({
      ...credentials,
      name: id,
      resume: true,
    });
    return new VercelSandboxAdapter(
      id,
      sandbox,
      this.host,
      await this.readHome(sandbox),
    );
  }

  async list(): Promise<SandboxInfo[]> {
    const credentials = this.credentials();
    const { Sandbox } = await this.sdk();
    const sandboxes: SandboxInfo[] = [];
    for await (const sandbox of await Sandbox.list(credentials))
      sandboxes.push({
        id: sandbox.name,
        startedAt: new Date(sandbox.createdAt),
      });
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

  private async readHome(sandbox: VercelSandboxInstance): Promise<string> {
    const result = await sandbox.runCommand("bash", [
      "-lc",
      'printf %s "$HOME"',
    ]);
    const [stdout, stderr] = await Promise.all([
      result.stdout(),
      result.stderr(),
    ]);
    if (result.exitCode !== 0)
      throw new Error(`Home lookup failed: ${stderr || stdout}`);
    return stdout.trim();
  }
}
