import { expect, test } from "vitest";
import { buildManifest } from "./manifest.js";

test("builds manifest with remote paths derived from cwd", () => {
  const m = buildManifest({
    agent: "claude-code",
    originalCwd: "/Users/p/Keepon",
    sessionId: "abc",
    transcriptName: "abc.jsonl",
    ts: 42,
  });
  expect(m).toEqual({
    agent: "claude-code",
    originalCwd: "/Users/p/Keepon",
    remoteProj: "/home/user/Keepon",
    remoteEnc: "-home-user-Keepon",
    sessionId: "abc",
    transcriptName: "abc.jsonl",
    ts: 42,
  });
});
