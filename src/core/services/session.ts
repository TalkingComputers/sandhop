import type { Agent, SessionRef } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";

export interface SessionReader {
  latest(cwd: string): SessionRef | Promise<SessionRef>;
  byId(cwd: string, id: string): SessionRef | Promise<SessionRef>;
}

export class SessionService implements SessionReader {
  readonly host: HostDeps;
  readonly agent: Agent;

  constructor(host: HostDeps, agent: Agent) {
    this.host = host;
    this.agent = agent;
  }

  latest(cwd: string): SessionRef {
    const sessions = this.agent.matchSession(this.host, cwd);
    const session = sessions[0];
    if (!session)
      throw new Error(
        `No ${this.agent.id} session transcript found for ${cwd}`,
      );
    return session;
  }

  byId(cwd: string, id: string): SessionRef {
    const session = this.agent
      .matchSession(this.host, cwd)
      .find((candidate) => candidate.sessionId === id);
    if (!session)
      throw new Error(
        `No ${this.agent.id} session transcript found for ${cwd} (id ${id})`,
      );
    return session;
  }
}
