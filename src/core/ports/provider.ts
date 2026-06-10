import type { RemotePath } from "../paths.js";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandInvocation {
  readonly file: string;
  readonly args: readonly string[];
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export type ServiceReadiness =
  | {
      readonly kind: "http";
      readonly url: string;
      readonly status: number;
      readonly timeoutMs: number;
      readonly intervalMs: number;
    }
  | {
      readonly kind: "log";
      readonly path: RemotePath;
      readonly matches: readonly RegExp[];
      readonly capture?: RegExp;
      readonly timeoutMs: number;
      readonly intervalMs: number;
    };

export interface ServiceSpec extends CommandInvocation {
  readonly port: number;
  readonly readiness: ServiceReadiness;
  readonly stdoutPath: RemotePath;
  readonly stderrPath: RemotePath;
  readonly appendOutput?: boolean;
}

export interface ReadyService {
  readonly port: number;
  readonly output: string;
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
  agentInstall?: string;
}

export interface ExposedPort {
  url: string;
}

export interface Sandbox {
  readonly id: string;
  readonly runtime: SandboxRuntime;
  readonly home: string;
  uploadFile(path: RemotePath, data: Uint8Array | string): Promise<void>;
  uploadPath(remotePath: RemotePath, localPath: string): Promise<void>;
  exec(
    file: string,
    args: readonly string[],
    opts?: ExecOptions,
  ): Promise<RunResult>;
  startService(service: ServiceSpec): Promise<ReadyService>;
  exposePort(port: number): Promise<ExposedPort>;
  destroy(): Promise<void>;
}

export const execShell = (
  sandbox: Pick<Sandbox, "exec">,
  script: string,
  opts?: ExecOptions,
): Promise<RunResult> => sandbox.exec("bash", ["-lc", script], opts);

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
