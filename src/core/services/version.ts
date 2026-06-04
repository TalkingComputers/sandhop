import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";

export interface VersionDetector {
  detect(): string | Promise<string>;
}

export class VersionService implements VersionDetector {
  readonly host: HostDeps;
  readonly agent: Agent;

  constructor(host: HostDeps, agent: Agent) {
    this.host = host;
    this.agent = agent;
  }

  detect(): string {
    const output = this.host
      .exec(this.agent.bin, this.agent.detectVersionArgs)
      .trim();
    return this.agent.parseVersion(output);
  }
}
