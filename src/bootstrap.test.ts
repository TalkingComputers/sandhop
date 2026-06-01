import { expect, test } from "vitest";
import { CLAUDE_CODE } from "./adapters.js";
import { renderBootstrap } from "./bootstrap.js";
import { buildManifest } from "./manifest.js";

const m = buildManifest({
  agent: "claude-code",
  originalCwd: "/Users/p/proj",
  sessionId: "abc",
  transcriptName: "abc.jsonl",
  ts: 1,
});

test("bootstrap installs, pre-seeds, extracts, places transcript, rewrites paths", () => {
  const s = renderBootstrap(m, CLAUDE_CODE);
  expect(s).toContain("npm i -g @anthropic-ai/claude-code");
  expect(s).toContain("hasCompletedOnboarding");
  expect(s).toContain("tar -xzf /tmp/bundle.tgz -C /home/user/proj");
  expect(s).toContain("$HOME/.claude/projects/-home-user-proj/abc.jsonl");
  expect(s).toContain("s#/Users/p/proj#/home/user/proj#g");
  expect(s).toContain("KEEPON_RESTORE_OK");
  expect(s).not.toContain("ttyd");
});
