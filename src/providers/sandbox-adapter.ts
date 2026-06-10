import { quote } from "shell-quote";
import type { RemotePath } from "../core/paths.js";
import type {
  ExecOptions,
  ExposedPort,
  RunResult,
  Sandbox,
  SandboxRuntime,
  ServiceSpec,
} from "../core/ports/provider.js";
import { buildRuntimeEnv, envPairs } from "../core/sandbox-runtime.js";

export interface ResolvedExecOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface ProviderOps {
  uploadFile(path: RemotePath, data: Uint8Array | string): Promise<void>;
  uploadPath(remotePath: RemotePath, localPath: string): Promise<void>;
  exec(
    file: string,
    args: readonly string[],
    opts: ResolvedExecOptions,
  ): Promise<RunResult>;
  spawnService(service: ServiceSpec): Promise<void>;
  exposePort(port: number): Promise<ExposedPort>;
  destroy(): Promise<void>;
}

type Exec = Sandbox["exec"];
export const DEFAULT_EXEC_TIMEOUT_MS = 600_000;
const READINESS_PROBE_TIMEOUT_MS = 10000;

const resolveExecOptions = (
  runtime: SandboxRuntime,
  opts?: ExecOptions,
): ResolvedExecOptions => ({
  cwd: opts?.cwd ?? runtime.workdir,
  env: { ...opts?.env, ...buildRuntimeEnv(runtime) },
  timeoutMs: opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
});

const envArgs = (env: Record<string, string> | undefined): string[] =>
  env === undefined ? [] : ["env", ...envPairs(env)];

const renderRedirects = (script: string, service: ServiceSpec): string => {
  const stdout = ` ${service.appendOutput === true ? ">>" : ">"} ${quote([service.stdoutPath])}`;
  const stderr =
    service.stdoutPath === service.stderrPath
      ? " 2>&1"
      : ` ${service.appendOutput === true ? "2>>" : "2>"} ${quote([service.stderrPath])}`;
  return `${script}${stdout}${stderr}`;
};

export const renderShellCall = (
  file: string,
  args: readonly string[],
  opts?: Pick<ExecOptions, "cwd" | "env">,
): string => {
  const call = quote([...envArgs(opts?.env), file, ...args]);
  return opts?.cwd === undefined ? call : `cd ${quote([opts.cwd])} && ${call}`;
};

export const renderCommandCall = (
  file: string,
  args: readonly string[],
): string => quote([file, ...args]);

export const renderServiceShell = (
  service: ServiceSpec,
  cwd?: string,
): string =>
  renderRedirects(
    renderShellCall(service.file, service.args, { cwd }),
    service,
  );

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

const readReady = async (
  exec: Exec,
  service: ServiceSpec,
): Promise<string | null> => {
  const readiness = service.readiness;
  if (readiness.kind === "http") {
    const result = await exec(
      "curl",
      ["-sS", "-o", "/dev/null", "-w", "%{http_code}", readiness.url],
      { timeoutMs: READINESS_PROBE_TIMEOUT_MS },
    );
    return result.exitCode === 0 &&
      result.stdout.trim() === String(readiness.status)
      ? ""
      : null;
  }
  const result = await exec("cat", [readiness.path], {
    timeoutMs: READINESS_PROBE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return null;
  if (!readiness.matches.every((match) => match.test(result.stdout)))
    return null;
  if (readiness.capture === undefined) return "";
  const captured = readiness.capture.exec(result.stdout);
  if (captured === null) return null;
  const output = captured[1];
  if (output === undefined)
    throw new Error(`Service readiness capture missing: ${readiness.path}`);
  return output;
};

export const waitForServiceReadiness = async (
  exec: Exec,
  service: ServiceSpec,
): Promise<string> => {
  const start = Date.now();
  let output = await readReady(exec, service);
  while (output === null && Date.now() - start < service.readiness.timeoutMs) {
    await sleep(service.readiness.intervalMs);
    output = await readReady(exec, service);
  }
  if (output !== null) return output;
  const logs = await exec("tail", ["-n", "80", service.stderrPath], {
    timeoutMs: 5000,
  });
  throw new Error(
    `Service failed to become ready: ${service.file}: ${logs.stderr.length > 0 ? logs.stderr : logs.stdout}`,
  );
};

export const createSandbox = (
  id: string,
  runtime: SandboxRuntime,
  ops: ProviderOps,
): Sandbox => {
  const exec: Exec = (file, args, opts) =>
    ops.exec(file, args, resolveExecOptions(runtime, opts));
  return {
    id,
    runtime,
    home: runtime.home,
    uploadFile: ops.uploadFile,
    uploadPath: ops.uploadPath,
    exec,
    startService: async (service) => {
      await ops.spawnService(service);
      return {
        port: service.port,
        output: await waitForServiceReadiness(exec, service),
      };
    },
    exposePort: ops.exposePort,
    destroy: ops.destroy,
  };
};
