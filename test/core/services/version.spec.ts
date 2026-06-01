import { expect, test } from "vitest";
import { CODEX } from "../../../src/agents/codex.js";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { VersionService } from "../../../src/core/services/version.js";
import { FakeHost } from "../../fakes/host.js";

test("VersionService detects exact local CLI semver with agent binaries", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    execValues: {
      "claude --version": "claude 2.1.160\n",
      "codex --version": "codex 0.136.0\n",
    },
  });

  expect(new VersionService(host, CLAUDE_CODE).detect()).toBe("2.1.160");
  expect(new VersionService(host, CODEX).detect()).toBe("0.136.0");
  expect(host.execCalls).toEqual([
    { bin: "claude", args: ["--version"] },
    { bin: "codex", args: ["--version"] },
  ]);
});
