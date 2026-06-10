import { expect, test } from "vitest";
import { resolveSession } from "../../src/agents/index.js";
import { projectDirName } from "../../src/core/encode.js";
import { FakeHost } from "../fakes/host.js";

test("resolveSession selects the newest Claude transcript for the cwd", () => {
  const cwd = "/workspace/project";
  const root = `/home/local/.claude/projects/${projectDirName(cwd)}`;
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      [`${root}/old.jsonl`]: "old",
      [`${root}/new.jsonl`]: "new",
    },
    mtimes: { [`${root}/old.jsonl`]: 1, [`${root}/new.jsonl`]: 2 },
  });

  expect(resolveSession(host, cwd, "claude-code", undefined).session).toEqual({
    sessionId: "new",
    transcriptPath: `${root}/new.jsonl`,
    transcriptName: "new.jsonl",
  });
});

test("resolveSession selects Codex rollouts by recorded cwd and rollout id", () => {
  const cwd = "/workspace/project";
  const matching =
    "/home/local/.codex/sessions/2026/06/01/rollout-2026-06-01T00-00-00-session-id.jsonl";
  const other =
    "/home/local/.codex/sessions/2026/06/01/rollout-2026-06-01T00-00-00-other-id.jsonl";
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      [matching]: `${JSON.stringify({ type: "session_meta", payload: { cwd } })}\n`,
      [other]: `${JSON.stringify({ type: "session_meta", payload: { cwd: "/other" } })}\n`,
    },
    mtimes: { [matching]: 1, [other]: 2 },
  });

  expect(resolveSession(host, cwd, "codex", undefined).session).toEqual({
    sessionId: "session-id",
    transcriptPath: matching,
    transcriptName: "rollout-2026-06-01T00-00-00-session-id.jsonl",
  });
});

test("resolveSession picks an explicit session id within the chosen agent", () => {
  const cwd = "/workspace/project";
  const root = `/home/local/.claude/projects/${projectDirName(cwd)}`;
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      [`${root}/old.jsonl`]: "old",
      [`${root}/new.jsonl`]: "new",
    },
    mtimes: { [`${root}/old.jsonl`]: 1, [`${root}/new.jsonl`]: 2 },
  });

  expect(resolveSession(host, cwd, undefined, "old").session.sessionId).toBe(
    "old",
  );
  expect(() => resolveSession(host, cwd, undefined, "missing")).toThrow(
    `No claude-code session transcript found for ${cwd} (id missing)`,
  );
});

test("resolveSession fails fast when no sessions exist", () => {
  const host = new FakeHost({ home: "/home/local", env: {} });

  expect(() =>
    resolveSession(host, "/workspace/project", undefined, undefined),
  ).toThrow("No Claude Code or Codex session found for /workspace/project");
  expect(() =>
    resolveSession(host, "/workspace/project", "codex", undefined),
  ).toThrow("No codex session found for /workspace/project");
});
