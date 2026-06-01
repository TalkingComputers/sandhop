import { expect, test } from "vitest";
import { parseArgs, readTailscaleOption } from "../../src/cli/args.js";

test("parseArgs keeps push defaults and binary flags", () => {
  expect(parseArgs([], "/workspace/project")).toMatchObject({
    cmd: "push",
    cwd: "/workspace/project",
    profile: true,
    tailscale: false,
  });
  expect(
    parseArgs(["push", "--no-profile", "--tailscale"], "/workspace/project"),
  ).toMatchObject({
    cmd: "push",
    profile: false,
    tailscale: true,
  });
  expect(
    parseArgs(["push", "--cwd", "/workspace/other"], "/workspace/project"),
  ).toMatchObject({
    cmd: "push",
    cwd: "/workspace/other",
  });
});

test("readTailscaleOption requires TS_AUTHKEY only in tailscale mode", () => {
  expect(
    readTailscaleOption(parseArgs([], "/workspace/project"), {}),
  ).toBeUndefined();
  expect(
    readTailscaleOption(
      parseArgs(["push", "--tailscale"], "/workspace/project"),
      {
        TS_AUTHKEY: "tskey-auth-test",
      },
    ),
  ).toEqual({ authKey: "tskey-auth-test" });
  expect(() =>
    readTailscaleOption(
      parseArgs(["push", "--tailscale"], "/workspace/project"),
      {},
    ),
  ).toThrow("TS_AUTHKEY is required when --tailscale is set");
});
