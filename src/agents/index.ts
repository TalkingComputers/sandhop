import type {
  Agent,
  AgentId,
  AgentSessionDeps,
  SessionRef,
} from "../core/ports/agent.js";
import { CLAUDE_CODE } from "./claude-code.js";
import { CODEX } from "./codex.js";

export const AGENTS = [CLAUDE_CODE, CODEX] as const;

export const pickAgent = (id: AgentId): Agent => {
  for (const agent of AGENTS) if (agent.id === id) return agent;
  throw new Error(`Unknown agent ${id}`);
};

export interface ResolvedSession {
  agent: Agent;
  session: SessionRef;
  detectedAgents: AgentId[];
}

interface MatchedAgent {
  agent: Agent;
  sessions: SessionRef[];
}

const newestMatch = (
  host: AgentSessionDeps,
  matched: MatchedAgent[],
): MatchedAgent | null => {
  let newest: MatchedAgent | null = null;
  for (const candidate of matched) {
    if (
      newest === null ||
      host.statMtimeMs(candidate.sessions[0]!.transcriptPath) >
        host.statMtimeMs(newest.sessions[0]!.transcriptPath)
    )
      newest = candidate;
  }
  return newest;
};

export const resolveSession = (
  host: AgentSessionDeps,
  cwd: string,
  agentId: AgentId | undefined,
  sessionId: string | undefined,
): ResolvedSession => {
  const candidates = agentId === undefined ? AGENTS : [pickAgent(agentId)];
  const matched = candidates
    .map((agent) => ({ agent, sessions: agent.matchSession(host, cwd) }))
    .filter(({ sessions }) => sessions.length > 0);
  const newest = newestMatch(host, matched);
  if (newest === null)
    throw new Error(
      agentId === undefined
        ? `No Claude Code or Codex session found for ${cwd}`
        : `No ${agentId} session found for ${cwd}`,
    );
  const session =
    sessionId === undefined
      ? newest.sessions[0]!
      : newest.sessions.find((candidate) => candidate.sessionId === sessionId);
  if (session === undefined)
    throw new Error(
      `No ${newest.agent.id} session transcript found for ${cwd} (id ${sessionId})`,
    );
  return {
    agent: newest.agent,
    session,
    detectedAgents: matched.map(({ agent }) => agent.id),
  };
};
