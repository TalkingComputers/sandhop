import type { AgentSessionDeps, SessionRef } from "../core/ports/agent.js";

export const sortNewest = (
  deps: AgentSessionDeps,
  refs: SessionRef[],
): SessionRef[] =>
  [...refs].sort(
    (a, b) =>
      deps.statMtimeMs(b.transcriptPath) - deps.statMtimeMs(a.transcriptPath),
  );

export const makeVersionParser =
  (label: string): ((output: string) => string) =>
  (output: string): string => {
    const match = output.match(/(\d+\.\d+\.\d+)/);
    if (!match)
      throw new Error(`Could not parse ${label} version from "${output}"`);
    return match[1]!;
  };
