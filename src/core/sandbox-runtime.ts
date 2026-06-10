import { quote } from "shell-quote";
import type {
  ExecOptions,
  RunResult,
  Sandbox,
  SandboxRuntime,
} from "./ports/provider.js";

export const RUNTIME_HOME_ENV = "SANDHOP_RUNTIME_HOME";
export const RUNTIME_USER_ENV = "SANDHOP_RUNTIME_USER";
export const RUNTIME_WORKDIR_ENV = "SANDHOP_RUNTIME_WORKDIR";
export const RUNTIME_HOME_METADATA = "sandhop.runtime.home";
export const RUNTIME_USER_METADATA = "sandhop.runtime.user";
export const RUNTIME_WORKDIR_METADATA = "sandhop.runtime.workdir";
export const TTYD_VERSION = "1.7.7";
export const CLOUDFLARED_VERSION = "2026.5.2";

const LINUX_USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/;

export const validateRuntime = (runtime: SandboxRuntime): SandboxRuntime => {
  if (!LINUX_USERNAME.test(runtime.username) || runtime.username === "root")
    throw new Error(
      `Sandbox runtime username must be a non-root Linux username: ${runtime.username}`,
    );
  for (const [label, path] of [
    ["home", runtime.home],
    ["workdir", runtime.workdir],
  ] as const)
    if (!path.startsWith("/") || path.includes("\n") || path.includes("\r"))
      throw new Error(
        `Sandbox runtime ${label} must be an absolute path: ${path}`,
      );
  return runtime;
};

export const envPairs = (env: Record<string, string>): string[] =>
  Object.entries(env).map(([key, value]) => `${key}=${value}`);

export const buildRuntimeEnv = (
  runtime: SandboxRuntime,
): Record<string, string> => ({
  HOME: runtime.home,
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  [RUNTIME_HOME_ENV]: runtime.home,
  [RUNTIME_USER_ENV]: runtime.username,
  [RUNTIME_WORKDIR_ENV]: runtime.workdir,
});

export const buildRuntimeMetadata = (
  runtime: SandboxRuntime,
): Record<string, string> => ({
  [RUNTIME_HOME_METADATA]: runtime.home,
  [RUNTIME_USER_METADATA]: runtime.username,
  [RUNTIME_WORKDIR_METADATA]: runtime.workdir,
});

const readMetadataValue = (
  metadata: Record<string, string> | undefined,
  key: string,
): string => {
  const value = metadata?.[key];
  if (value === undefined || value === "")
    throw new Error(`Sandbox runtime metadata missing: ${key}`);
  return value;
};

export const readRuntimeMetadata = (
  metadata: Record<string, string> | undefined,
): SandboxRuntime =>
  validateRuntime({
    home: readMetadataValue(metadata, RUNTIME_HOME_METADATA),
    username: readMetadataValue(metadata, RUNTIME_USER_METADATA),
    workdir: readMetadataValue(metadata, RUNTIME_WORKDIR_METADATA),
  });

export const buildRunuserArgs = (
  runtime: SandboxRuntime,
  script: string,
): string[] => [
  "runuser",
  "-u",
  runtime.username,
  "--",
  "env",
  ...envPairs(buildRuntimeEnv(runtime)),
  "bash",
  "-lc",
  script,
];

export const execShellAsUser = (
  sandbox: Sandbox,
  script: string,
  opts?: ExecOptions,
): Promise<RunResult> => {
  const args = buildRunuserArgs(sandbox.runtime, script);
  return sandbox.exec(args[0]!, args.slice(1), opts);
};

export const buildRuntimeUserScript = (runtime: SandboxRuntime): string => {
  const owner = quote([`${runtime.username}:${runtime.username}`]);
  const profile = quote([`${runtime.home}/.profile`]);
  return [
    `mkdir -p ${quote([runtime.home])} ${quote([runtime.workdir])}`,
    `useradd --user-group --create-home --home-dir ${quote([runtime.home])} --shell /bin/bash ${quote([runtime.username])}`,
    `printf '%s\\n' 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"' 'export LANG=C.UTF-8 LC_ALL=C.UTF-8' > ${profile}`,
    `chown -R ${owner} ${quote([runtime.home])} ${quote([runtime.workdir])}`,
  ].join(" && ");
};

export const buildSandboxToolInstallScript = (): string =>
  [
    'ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) TTYD_ARCH=aarch64; CF_ARCH=arm64;; *) TTYD_ARCH=x86_64; CF_ARCH=amd64;; esac',
    `curl -fsSL https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.\${TTYD_ARCH} -o /usr/local/bin/ttyd`,
    "chmod +x /usr/local/bin/ttyd",
    `curl -fsSL https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-\${CF_ARCH} -o /usr/local/bin/cloudflared`,
    "chmod +x /usr/local/bin/cloudflared",
  ].join(" && ");
