import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";

export class SecretsService {
  readonly host: HostDeps;
  readonly agent: Agent;

  constructor(host: HostDeps, agent: Agent) {
    this.host = host;
    this.agent = agent;
  }

  collect(cwd: string): Record<string, string> {
    const names = new Set<string>();
    for (const path of this.agent.mcpConfigPaths(this.host.home, cwd)) {
      const text = this.host.readFile(path);
      if (text === null) continue;
      for (const name of this.agent.mcpEnvRefs(text)) names.add(name);
    }
    const envs: Record<string, string> = {};
    for (const name of [...names].sort()) {
      const value = this.host.env[name];
      if (value !== undefined) envs[name] = value;
    }
    return envs;
  }
}
