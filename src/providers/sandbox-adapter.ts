import { quote } from "shell-quote";
import type {
  ExecOptions,
  RunResult,
  Sandbox,
  SpawnOptions,
} from "../core/ports/provider.js";

export type SandboxOps = Omit<Sandbox, "home" | "id">;

const envArgs = (env: Record<string, string> | undefined): string[] =>
  env === undefined
    ? []
    : Object.entries(env).map(([key, value]) => `${key}=${value}`);

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

export const renderDetachedShell = (
  script: string,
  opts?: SpawnOptions,
): string =>
  `nohup bash -lc ${quote([renderRedirects(script, opts)])} >/dev/null 2>&1 &`;

export const createSandbox = (
  id: string,
  home: string,
  ops: SandboxOps,
): Sandbox => ({ id, home, ...ops });

export const readSandboxHome = async (
  run: (file: string, args: readonly string[]) => Promise<RunResult>,
): Promise<string> => {
  const result = await run("bash", ["-lc", 'printf %s "$HOME"']);
  if (result.exitCode !== 0)
    throw new Error(
      `Home lookup failed: ${result.stderr.length > 0 ? result.stderr : result.stdout}`,
    );
  const home = result.stdout.trim();
  if (home.length === 0) throw new Error("Home lookup returned empty path");
  return home;
};
