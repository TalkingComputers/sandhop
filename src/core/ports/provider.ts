import type { RemotePath } from "../paths.js";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SpawnOptions {
  appendOutput?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  stderrPath?: RemotePath;
  stdoutPath?: RemotePath;
}

export interface SandboxRuntime {
  home: string;
  username: string;
  workdir: string;
}

export interface CreateOptions {
  envs: Record<string, string>;
  timeoutMs: number;
  ports: number[];
  runtime: SandboxRuntime;
}

export interface ExposedPort {
  url: string;
}

export interface Sandbox {
  readonly id: string;
  readonly home: string;
  uploadFile(path: RemotePath, data: Uint8Array | string): Promise<void>;
  uploadPath(remotePath: RemotePath, localPath: string): Promise<void>;
  exec(
    file: string,
    args: readonly string[],
    opts?: ExecOptions,
  ): Promise<RunResult>;
  spawn(
    file: string,
    args: readonly string[],
    opts?: SpawnOptions,
  ): Promise<void>;
  exposePort(port: number): Promise<ExposedPort>;
  destroy(): Promise<void>;
}

export const execShell = (
  sandbox: Pick<Sandbox, "exec">,
  script: string,
  opts?: ExecOptions,
): Promise<RunResult> => sandbox.exec("bash", ["-lc", script], opts);

export const spawnShell = (
  sandbox: Pick<Sandbox, "spawn">,
  script: string,
  opts?: SpawnOptions,
): Promise<void> => sandbox.spawn("bash", ["-lc", script], opts);

export interface SandboxInfo {
  id: string;
  startedAt: Date;
}

export interface SandboxProvider {
  readonly name: string;
  create(opts: CreateOptions): Promise<Sandbox>;
  connect(id: string): Promise<Sandbox>;
  list(): Promise<SandboxInfo[]>;
  destroy(id: string): Promise<boolean>;
}
