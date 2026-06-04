export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CreateOptions {
  image?: string;
  envs: Record<string, string>;
  timeoutMs: number;
  ports?: number[];
}

export interface ExposedPort {
  url: string;
  token?: string;
  authGatedByProvider: boolean;
}

export interface Sandbox {
  readonly id: string;
  uploadFile(path: string, data: Uint8Array | string): Promise<void>;
  uploadPath(remotePath: string, localPath: string): Promise<void>;
  exec(cmd: string): Promise<RunResult>;
  spawn(cmd: string): Promise<void>;
  exposePort(port: number): Promise<ExposedPort>;
  destroy(): Promise<void>;
}

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
