import type { Agent, AgentId } from "../core/ports/agent.js";
import type { HostDeps } from "../core/ports/host.js";
import { SessionService } from "../core/services/session.js";
import { CLAUDE_CODE } from "./claude-code.js";
import { CODEX } from "./codex.js";

export const AGENTS = [CLAUDE_CODE, CODEX] as const;

export const detectAgents = (host: HostDeps, cwd: string): Agent[] =>
  AGENTS.filter((agent) => agent.matchSession(host, cwd).length > 0);

export const pickAgent = (id: AgentId): Agent => {
  for (const agent of AGENTS) if (agent.id === id) return agent;
  throw new Error(`Unknown agent ${id}`);
};

export const selectDefaultAgent = (agents: Agent[]): Agent => {
  const claude = agents.find((agent) => agent.id === "claude-code");
  if (claude) return claude;
  const first = agents[0];
  if (!first) throw new Error("No Claude Code or Codex session found");
  return first;
};

export const findLatestSession = (host: HostDeps, cwd: string, agent: Agent) =>
  new SessionService(host, agent).latest(cwd);
