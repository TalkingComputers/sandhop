import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";

export interface SecretsInputs {
  envRefs: string[];
  referencedFiles: string[];
}

export interface SecretsBundle {
  envs: Record<string, string>;
  files: { path: string; content: string }[];
}

const remotePath = (home: string, path: string): string => {
  if (path === home) return "$HOME";
  if (path.startsWith(`${home}/`)) return `$HOME${path.slice(home.length)}`;
  return path;
};

const HOST_ENV_NAMES = new Set([
  "HOME",
  "PATH",
  "PWD",
  "OLDPWD",
  "USER",
  "LOGNAME",
  "SHELL",
  "SHLVL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "MAIL",
  "EDITOR",
]);

const HOST_ENV_PATTERN =
  /^(npm_config_|NODE_|FNM_|__MISE|MISE_|NVM_|VOLTA_|ZSH|BASH)/i;

const isHostEnvName = (name: string): boolean =>
  HOST_ENV_NAMES.has(name) || HOST_ENV_PATTERN.test(name);

export class SecretsService {
  readonly host: HostDeps;
  readonly agent: Agent;

  constructor(host: HostDeps, agent: Agent) {
    this.host = host;
    this.agent = agent;
  }

  collect(cwd: string, inputs?: SecretsInputs): SecretsBundle {
    const names = new Set<string>();
    for (const path of this.agent.mcpConfigPaths(this.host.home, cwd)) {
      const text = this.host.readFile(path);
      if (text === null) continue;
      for (const name of this.agent.mcpEnvRefs(text)) names.add(name);
    }
    if (inputs !== undefined) {
      for (const name of inputs.envRefs) names.add(name);
    }
    const envs: Record<string, string> = {};
    for (const name of [...names].sort()) {
      if (isHostEnvName(name)) continue;
      const value = this.host.env[name];
      if (value !== undefined) envs[name] = value;
    }
    const files: { path: string; content: string }[] = [];
    if (inputs !== undefined) {
      for (const path of [...inputs.referencedFiles].sort()) {
        const content = this.host.readFile(path);
        if (content === null)
          throw new Error(`Referenced MCP file not found: ${path}`);
        files.push({ path: remotePath(this.host.home, path), content });
      }
    }
    return { envs, files };
  }
}
