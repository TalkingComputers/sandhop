import type { AgentSessionDeps } from "../core/ports/agent.js";

export interface CodexTranscriptName {
  sessionId: string;
  year: string;
  month: string;
  day: string;
}

export const parseCodexTranscriptName = (file: string): CodexTranscriptName => {
  const match = file.match(
    /rollout-(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T\d{2}-\d{2}-\d{2}-(?<sessionId>.+)\.jsonl$/,
  );
  if (match === null || match.groups === undefined)
    throw new Error(`Invalid Codex transcript filename ${file}`);
  const { year, month, day, sessionId } = match.groups;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    sessionId === undefined
  )
    throw new Error(`Invalid Codex transcript filename ${file}`);
  return { sessionId, year, month, day };
};

export const codexId = (file: string): string => {
  return parseCodexTranscriptName(file).sessionId;
};

export const readRecordedCwd = (
  deps: AgentSessionDeps,
  path: string,
): string | null => {
  const text = deps.readFile(path);
  if (text === null) return null;
  const first = text.split("\n", 1)[0]!;
  try {
    const parsed = JSON.parse(first) as { payload?: { cwd?: unknown } };
    return typeof parsed.payload?.cwd === "string" ? parsed.payload.cwd : null;
  } catch {
    return null;
  }
};
