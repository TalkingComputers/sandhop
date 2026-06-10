import { expect, test } from "vitest";
import { CODEX } from "../../../src/agents/codex.js";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { detectVersion } from "../../../src/core/services/version.js";
import { FakeHost } from "../../fakes/host.js";

test("detectVersion detects exact local CLI semver with agent binaries", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    execValues: {
      "claude --version": "claude 2.1.160\n",
      "codex --version": "codex 0.136.0\n",
    },
  });

  expect(detectVersion(host, CLAUDE_CODE)).toBe("2.1.160");
  expect(detectVersion(host, CODEX)).toBe("0.136.0");
  expect(host.execCalls).toEqual([
    { bin: "claude", args: ["--version"] },
    { bin: "codex", args: ["--version"] },
  ]);
});
