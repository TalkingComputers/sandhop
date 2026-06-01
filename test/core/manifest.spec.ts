import { expect, test } from "vitest";
import { buildManifest } from "../../src/core/manifest.js";

test("buildManifest carries session metadata and derives remote paths", () => {
  expect(
    buildManifest({
      agent: "codex",
      cliVersion: "0.136.0",
      originalCwd: "/Users/parsa/My Project",
      sessionId: "session-id",
      transcriptName: "rollout.jsonl",
      ts: 1,
    }),
  ).toEqual({
    agent: "codex",
    cliVersion: "0.136.0",
    originalCwd: "/Users/parsa/My Project",
    remoteProj: "/home/user/My-Project",
    remoteEnc: "-home-user-My-Project",
    sessionId: "session-id",
    transcriptName: "rollout.jsonl",
    ts: 1,
  });
});
