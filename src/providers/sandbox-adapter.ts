import { quote } from "shell-quote";
import type {
  ExecOptions,
  Sandbox,
  SandboxRuntime,
  SpawnOptions,
} from "../core/ports/provider.js";

export type SandboxOps = Omit<Sandbox, "home" | "id" | "runtime">;

const envArgs = (env: Record<string, string> | undefined): string[] =>
  env === undefined
    ? []
    : ["env", ...Object.entries(env).map(([key, value]) => `${key}=${value}`)];

const renderRedirects = (
  script: string,
  opts: SpawnOptions | undefined,
): string => {
  if (opts?.stdoutPath === undefined && opts?.stderrPath === undefined)
    return script;
  const stdout =
    opts.stdoutPath === undefined
      ? ""
      : ` ${opts.appendOutput === true ? ">>" : ">"} ${quote([opts.stdoutPath])}`;
  const stderr =
    opts.stderrPath === undefined
      ? ""
      : opts.stdoutPath === opts.stderrPath
        ? " 2>&1"
        : ` ${opts.appendOutput === true ? "2>>" : "2>"} ${quote([opts.stderrPath])}`;
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

export const renderDetachedShell = (
  script: string,
  opts?: SpawnOptions,
): string =>
  `nohup bash -lc ${quote([renderRedirects(script, opts)])} >/dev/null 2>&1 &`;

export const createSandbox = (
  id: string,
  runtime: SandboxRuntime,
  ops: SandboxOps,
): Sandbox => ({ id, runtime, home: runtime.home, ...ops });
