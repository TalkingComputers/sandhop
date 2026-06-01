import { expect, test } from "vitest";
import { parseArgs, readTailscaleOption } from "./cli.js";

test("defaults to push with cwd", () => {
  const a = parseArgs([], "/x");
  expect(a.cmd).toBe("push");
  expect(a.cwd).toBe("/x");
});

test("parses agent and session flags", () => {
  const a = parseArgs(["push", "--agent", "codex", "--session", "u-1"], "/x");
  expect(a).toMatchObject({ cmd: "push", agent: "codex", session: "u-1" });
});

test("parses cwd flag", () => {
  const a = parseArgs(["push", "--cwd", "/project"], "/x");
  expect(a).toMatchObject({ cmd: "push", cwd: "/project" });
});

test("parses tailscale flag", () => {
  const a = parseArgs(["push", "--tailscale"], "/x");
  expect(a).toMatchObject({ cmd: "push", tailscale: true });
});

test("reads tailscale auth key when enabled", () => {
  expect(
    readTailscaleOption(parseArgs(["push", "--tailscale"], "/x"), {
      TS_AUTHKEY: "tskey-auth-abc",
    }),
  ).toEqual({ authKey: "tskey-auth-abc" });
});

test("throws when tailscale auth key is missing", () => {
  expect(() =>
    readTailscaleOption(parseArgs(["push", "--tailscale"], "/x"), {}),
  ).toThrow("TS_AUTHKEY is required when --tailscale is set");
});

test("parses kill with id", () => {
  const a = parseArgs(["kill", "sbx-9"], "/x");
  expect(a).toMatchObject({ cmd: "kill", killId: "sbx-9" });
});
