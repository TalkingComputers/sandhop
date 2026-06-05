import type { Agent, AgentId } from "../core/ports/agent.js";
import type { HostDeps } from "../core/ports/host.js";
import { CLAUDE_CODE } from "./claude-code.js";
import { CODEX } from "./codex.js";

export const AGENTS = [CLAUDE_CODE, CODEX] as const;

export const detectAgents = (host: HostDeps, cwd: string): Agent[] =>
  AGENTS.filter((agent) => agent.matchSession(host, cwd).length > 0);

export const pickAgent = (id: AgentId): Agent => {
  for (const agent of AGENTS) if (agent.id === id) return agent;
  throw new Error(`Unknown agent ${id}`);
};

export const selectDefaultAgent = (
  host: HostDeps,
  cwd: string,
  agents: Agent[],
): Agent => {
  let selected: { agent: Agent; mtime: number } | null = null;
  for (const agent of agents) {
    const session = agent.matchSession(host, cwd)[0];
    if (session === undefined) continue;
    const mtime = host.statMtimeMs(session.transcriptPath);
    if (selected === null || mtime > selected.mtime)
      selected = { agent, mtime };
  }
  if (selected === null)
    throw new Error("No Claude Code or Codex session found");
  return selected.agent;
};
