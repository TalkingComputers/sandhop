import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import { collectReferencedInputs } from "./mcp-classify.js";
import { mapHomePath } from "./mcp-paths.js";

export interface SecretsBundle {
  envs: Record<string, string>;
  files: { path: string; content: string; mode: string }[];
}

export interface SecretsCollector {
  collect(cwd: string): SecretsBundle;
}

const SYSTEM_ENV_NAMES = new Set([
  "HOME",
  "PATH",
  "PWD",
  "OLDPWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "SHLVL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HOSTNAME",
  "MAIL",
  "_",
]);

export class SecretsService implements SecretsCollector {
  readonly host: HostDeps;
  readonly agent: Agent;

  constructor(host: HostDeps, agent: Agent) {
    this.host = host;
    this.agent = agent;
  }

  collect(cwd: string): SecretsBundle {
    const names = new Set<string>();
    const referencedFiles = new Set<string>();
    for (const path of this.agent.mcpConfigPaths(this.host.home, cwd)) {
      const text = this.host.readFile(path);
      if (text === null) continue;
      for (const name of this.agent.mcpEnvRefs(text)) names.add(name);
    }
    for (const name of this.agent.extraEnvRefs(this.host)) names.add(name);
    for (const server of this.agent.parseMcpServers(this.host, cwd)) {
      const referenced = collectReferencedInputs(this.host, server);
      for (const name of referenced.envRefs) names.add(name);
      for (const file of referenced.referencedFiles) referencedFiles.add(file);
    }
    const envs: Record<string, string> = {};
    for (const name of [...names].sort()) {
      if (SYSTEM_ENV_NAMES.has(name)) continue;
      const value = this.host.env[name];
      if (value !== undefined) envs[name] = value;
    }
    const files = [...referencedFiles].sort().map((path) => {
      const content = this.host.readFile(path);
      if (content === null)
        throw new Error(`Referenced MCP file not found: ${path}`);
      return {
        path: mapHomePath(this.host.home, "$HOME", path, "passthrough"),
        content,
        mode: "600",
      };
    });
    return { envs, files };
  }
}
