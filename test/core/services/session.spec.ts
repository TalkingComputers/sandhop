import { expect, test } from "vitest";
import { CODEX } from "../../../src/agents/codex.js";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { projectDirName } from "../../../src/core/encode.js";
import { SessionService } from "../../../src/core/services/session.js";
import { FakeHost } from "../../fakes/host.js";

test("SessionService selects the newest Claude transcript for the cwd", () => {
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

  expect(new SessionService(host, CLAUDE_CODE).latest(cwd)).toEqual({
    sessionId: "new",
    transcriptPath: `${root}/new.jsonl`,
    transcriptName: "new.jsonl",
  });
});

test("SessionService selects Codex rollouts by recorded cwd and rollout id", () => {
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

  expect(new SessionService(host, CODEX).latest(cwd)).toEqual({
    sessionId: "session-id",
    transcriptPath: matching,
    transcriptName: "rollout-2026-06-01T00-00-00-session-id.jsonl",
  });
});
