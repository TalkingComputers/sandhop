import { expect, test } from "vitest";
import { CLAUDE_CODE } from "./adapters.js";
import { renderBootstrap } from "./bootstrap.js";
import { buildManifest } from "./manifest.js";

const m = buildManifest({
  agent: "claude-code",
  cliVersion: "2.1.160",
  originalCwd: "/Users/p/proj",
  sessionId: "abc",
  transcriptName: "abc.jsonl",
  ts: 1,
});

test("bootstrap installs exact CLI version, pre-seeds, extracts, and copies transcript byte-exact", () => {
  const s = renderBootstrap(m, CLAUDE_CODE);
  expect(s).toContain(
    "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64",
  );
  expect(s).toContain("npm i -g @anthropic-ai/claude-code@2.1.160");
  expect(s).toContain("hasCompletedOnboarding");
  expect(s).toContain('projects[\\"/home/user/proj\\"]');
  expect(s).toContain("tar -xzf /tmp/bundle.tgz -C /home/user/proj");
  expect(s).toContain("$HOME/.claude/projects/-home-user-proj/abc.jsonl");
  expect(s).not.toContain("sed");
  expect(s).toContain("KEEPON_RESTORE_OK");
});
