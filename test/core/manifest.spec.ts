import { expect, test } from "vitest";
import { projectDirName } from "../../src/core/encode.js";
import { buildManifest } from "../../src/core/manifest.js";

test("buildManifest carries session metadata and derives remote paths", () => {
  const cwd = "/Users/parsa/My Project";

  expect(
    buildManifest({
      agent: "codex",
      cliVersion: "0.136.0",
      cwd,
      sessionId: "session-id",
      transcriptName: "rollout.jsonl",
      ts: 1,
    }),
  ).toEqual({
    agent: "codex",
    cliVersion: "0.136.0",
    remoteProj: cwd,
    remoteEnc: projectDirName(cwd),
    sessionId: "session-id",
    transcriptName: "rollout.jsonl",
    ts: 1,
  });
});
