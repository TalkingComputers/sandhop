import type {
  CreateOptions,
  ExecOptions,
  ExposedPort,
  RunResult,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
  SandboxRuntime,
  SpawnOptions,
} from "../../src/core/ports/provider.js";
import type { RemotePath } from "../../src/core/paths.js";

export class FakeSandbox implements Sandbox {
  readonly id: string;
  runtime: SandboxRuntime;
  uploads: { path: string; data: Uint8Array | string }[];
  pathUploads: { remotePath: string; localPath: string }[];
  execs: string[];
  execOptions: (ExecOptions | undefined)[];
  execResults: RunResult[];
  spawns: string[];
  exposedPorts: number[];
  destroyed: boolean;

  constructor(id: string, runtime: SandboxRuntime) {
    this.id = id;
    this.runtime = runtime;
    this.uploads = [];
    this.pathUploads = [];
    this.execs = [];
    this.execOptions = [];
    this.execResults = [];
    this.spawns = [];
    this.exposedPorts = [];
    this.destroyed = false;
  }

  get home(): string {
    return this.runtime.home;
  }

  async uploadFile(path: RemotePath, data: Uint8Array | string): Promise<void> {
    this.uploads.push({ path, data });
  }

  async uploadPath(remotePath: RemotePath, localPath: string): Promise<void> {
    this.pathUploads.push({ remotePath, localPath });
  }

  async exec(
    file: string,
    args: readonly string[],
    opts?: ExecOptions,
  ): Promise<RunResult> {
    this.execs.push(
      file === "bash" && args[0] === "-lc" && args[1] !== undefined
        ? args[1]
        : [file, ...args].join(" "),
    );
    this.execOptions.push(opts);
    const result = this.execResults.shift();
    if (result !== undefined) return result;
    return { exitCode: 0, stdout: "SANDHOP_RESTORE_OK\n", stderr: "" };
  }

  async spawn(
    file: string,
    args: readonly string[],
    opts?: SpawnOptions,
  ): Promise<void> {
    this.spawns.push(
      [
        file === "bash" && args[0] === "-lc" && args[1] !== undefined
          ? args[1]
          : [file, ...args].join(" "),
        JSON.stringify(opts),
      ].join(" "),
    );
  }

  async exposePort(port: number): Promise<ExposedPort> {
    this.exposedPorts.push(port);
    return { url: `https://sandbox-${this.id}-${port}.example` };
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

export class FakeProvider implements SandboxProvider {
  readonly name = "fake";
  readonly sandbox: FakeSandbox;
  creates: CreateOptions[];
  connectedIds: string[];
  destroyedIds: string[];

  constructor(
    sandbox = new FakeSandbox("sbx-1", {
      home: "/home/user",
      username: "user",
      workdir: "/home/user",
    }),
  ) {
    this.sandbox = sandbox;
    this.creates = [];
    this.connectedIds = [];
    this.destroyedIds = [];
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    this.creates.push(opts);
    this.sandbox.runtime = opts.runtime;
    return this.sandbox;
  }

  async connect(id: string): Promise<Sandbox> {
    this.connectedIds.push(id);
    return this.sandbox;
  }

  async list(): Promise<SandboxInfo[]> {
    return [
      { id: this.sandbox.id, startedAt: new Date("2026-01-01T00:00:00Z") },
    ];
  }

  async destroy(id: string): Promise<boolean> {
    this.destroyedIds.push(id);
    return id === this.sandbox.id;
  }
}
