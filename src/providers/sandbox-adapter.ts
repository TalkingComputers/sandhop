import type {
  ExecOptions,
  ExposedPort,
  RunResult,
  Sandbox,
} from "../core/ports/provider.js";

export interface SandboxOps {
  uploadFile(path: string, data: Uint8Array | string): Promise<void>;
  uploadPath(remotePath: string, localPath: string): Promise<void>;
  exec(cmd: string, opts?: ExecOptions): Promise<RunResult>;
  spawn(cmd: string): Promise<void>;
  exposePort(port: number): Promise<ExposedPort>;
  destroy(): Promise<void>;
}

export class GenericSandbox implements Sandbox {
  constructor(
    readonly id: string,
    readonly home: string,
    private readonly ops: SandboxOps,
  ) {}

  uploadFile(path: string, data: Uint8Array | string): Promise<void> {
    return this.ops.uploadFile(path, data);
  }

  uploadPath(remotePath: string, localPath: string): Promise<void> {
    return this.ops.uploadPath(remotePath, localPath);
  }

  exec(cmd: string, opts?: ExecOptions): Promise<RunResult> {
    return this.ops.exec(cmd, opts);
  }

  spawn(cmd: string): Promise<void> {
    return this.ops.spawn(cmd);
  }

  exposePort(port: number): Promise<ExposedPort> {
    return this.ops.exposePort(port);
  }

  destroy(): Promise<void> {
    return this.ops.destroy();
  }
}

export const readSandboxHome = async (
  run: (cmd: string) => Promise<RunResult>,
): Promise<string> => {
  const result = await run('printf %s "$HOME"');
  if (result.exitCode !== 0)
    throw new Error(
      `Home lookup failed: ${result.stderr.length > 0 ? result.stderr : result.stdout}`,
    );
  const home = result.stdout.trim();
  if (home.length === 0) throw new Error("Home lookup returned empty path");
  return home;
};
