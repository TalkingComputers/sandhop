import type { Agent, AuthBundle } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";

export class AuthService {
  readonly host: HostDeps;
  readonly agent: Agent;

  constructor(host: HostDeps, agent: Agent) {
    this.host = host;
    this.agent = agent;
  }

  extract(): AuthBundle {
    return this.agent.authEnv(this.host);
  }
}
