import { expect, test } from "vitest";
import { parseArgs } from "./cli.js";

test("defaults to push with cwd", () => {
  const a = parseArgs([], "/x");
  expect(a.cmd).toBe("push");
  expect(a.cwd).toBe("/x");
});

test("parses agent and session flags", () => {
  const a = parseArgs(["push", "--agent", "codex", "--session", "u-1"], "/x");
  expect(a).toMatchObject({ cmd: "push", agent: "codex", session: "u-1" });
});

test("parses kill with id", () => {
  const a = parseArgs(["kill", "sbx-9"], "/x");
  expect(a).toMatchObject({ cmd: "kill", killId: "sbx-9" });
});
