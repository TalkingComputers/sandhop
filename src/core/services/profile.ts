import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";

const joinHome = (home: string, path: string): string => `${home}/${path}`;

export class ProfileService {
  readonly host: HostDeps;
  readonly agent: Agent;

  constructor(host: HostDeps, agent: Agent) {
    this.host = host;
    this.agent = agent;
  }

  async build(outPath: string): Promise<string | null> {
    const entries = this.agent
      .profilePaths(this.host.home)
      .filter((path) => this.host.exists(joinHome(this.host.home, path)));
    if (entries.length === 0) return null;
    await this.host.copyTree(this.host.home, entries, outPath);
    return outPath;
  }
}
