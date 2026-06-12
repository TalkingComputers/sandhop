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

interface RolloutMeta {
  forkedFromId: string | null;
}

const readMeta = (line: string): RolloutMeta | null => {
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      payload?: { forked_from_id?: unknown };
    };
    if (parsed.type !== "session_meta") return null;
    return {
      forkedFromId:
        typeof parsed.payload?.forked_from_id === "string"
          ? parsed.payload.forked_from_id
          : null,
    };
  } catch {
    return null;
  }
};

const isMetaLine = (line: string): boolean => readMeta(line) !== null;

const contentLines = (text: string): string[] =>
  text
    .split("\n")
    .filter((line) => line.length > 0)
    .filter((line) => !isMetaLine(line));

const findRollout = (
  deps: AgentSessionDeps,
  sessionId: string,
): string | null =>
  deps
    .walk(`${deps.home}/.codex/sessions`)
    .find((path) => path.endsWith(`-${sessionId}.jsonl`)) ?? null;

const entrySignature = (line: string): string => {
  try {
    const parsed = JSON.parse(line) as { payload?: unknown };
    return parsed.payload === undefined ? line : JSON.stringify(parsed.payload);
  } catch {
    return line;
  }
};

export const readModelProvider = (text: string): string | null => {
  const first = text.split("\n", 1)[0]!;
  try {
    const parsed = JSON.parse(first) as {
      type?: unknown;
      payload?: { model_provider?: unknown };
    };
    if (parsed.type !== "session_meta") return null;
    return typeof parsed.payload?.model_provider === "string"
      ? parsed.payload.model_provider
      : null;
  } catch {
    return null;
  }
};

export const hasConversation = (text: string): boolean =>
  text.split("\n").some((line) => {
    try {
      const parsed = JSON.parse(line) as { type?: unknown };
      return parsed.type === "response_item";
    } catch {
      return false;
    }
  });

interface RolloutLine {
  type?: unknown;
  payload?: {
    type?: unknown;
    name?: unknown;
    namespace?: unknown;
    call_id?: unknown;
    output?: unknown;
  };
}

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const collectChildIds = (text: string): string[] => {
  const spawnCallIds = new Set<string>();
  const ids = new Set<string>();
  const parsedLines: RolloutLine[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      parsedLines.push(JSON.parse(line) as RolloutLine);
    } catch {
      continue;
    }
  }
  for (const parsed of parsedLines) {
    const payload = parsed.payload;
    if (
      parsed.type === "response_item" &&
      payload?.type === "function_call" &&
      payload.namespace === "multi_agent_v1" &&
      typeof payload.call_id === "string"
    )
      spawnCallIds.add(payload.call_id);
  }
  for (const parsed of parsedLines) {
    const payload = parsed.payload;
    if (
      parsed.type !== "response_item" ||
      payload?.type !== "function_call_output" ||
      typeof payload.call_id !== "string" ||
      !spawnCallIds.has(payload.call_id) ||
      typeof payload.output !== "string"
    )
      continue;
    for (const match of payload.output.matchAll(UUID_PATTERN))
      ids.add(match[0]);
  }
  return [...ids];
};

// Subagent threads spawned via multi_agent_v1 live as ordinary rollouts in
// the sessions tree; the resumed parent inspects them through /agent, so
// they travel with the session (including children of children).
export const collectSubagentRollouts = (
  deps: AgentSessionDeps,
  transcript: string,
): string[] => {
  const found = new Map<string, string>();
  const seen = new Set<string>();
  const queue = collectChildIds(transcript);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const path = findRollout(deps, id);
    if (path === null) continue;
    found.set(id, path);
    const text = deps.readFile(path);
    if (text !== null) queue.push(...collectChildIds(text));
  }
  return [...found.values()].sort();
};

export const mergeForkAncestry = (
  deps: AgentSessionDeps,
  transcript: string,
): string => {
  const lines = transcript.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) return transcript;
  const meta = readMeta(lines[0]!);
  if (meta === null) return transcript;
  const forkSignatures = new Set(lines.map(entrySignature));
  const inherited: string[] = [];
  let forkedFromId = meta.forkedFromId;
  const seen = new Set<string>();
  while (forkedFromId !== null && !seen.has(forkedFromId)) {
    seen.add(forkedFromId);
    const parentPath = findRollout(deps, forkedFromId);
    if (parentPath === null) break;
    const parentText = deps.readFile(parentPath);
    if (parentText === null) break;
    const parentLines = contentLines(parentText);
    const lastParentLine = parentLines[parentLines.length - 1];
    if (
      lastParentLine !== undefined &&
      forkSignatures.has(entrySignature(lastParentLine))
    )
      return transcript;
    inherited.unshift(...parentLines);
    const parentFirst = parentText.split("\n", 1)[0]!;
    forkedFromId = readMeta(parentFirst)?.forkedFromId ?? null;
  }
  if (inherited.length === 0) return transcript;
  return [lines[0]!, ...inherited, ...lines.slice(1)].join("\n") + "\n";
};
