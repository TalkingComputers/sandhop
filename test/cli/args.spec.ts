import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  buildTransport,
  parseArgs,
  readProvider,
  readTransport,
} from "../../src/cli/args.js";

test("args parser uses node:util parseArgs as the single parser", () => {
  const source = readFileSync("src/cli/args.ts", "utf8");

  expect(source).toContain('from "node:util"');
  expect(source).not.toContain("citty");
  expect(source).not.toContain("scanOptions");
  expect(source).not.toContain("VALUE_OPTIONS");
  expect(source).not.toContain("BOOLEAN_OPTIONS");
});

test("parseArgs keeps push defaults and flags", () => {
  expect(parseArgs([], "/workspace/project")).toMatchObject({
    cmd: "help",
    cwd: "/workspace/project",
    excludes: [],
    includes: [],
    provider: undefined,
    transport: undefined,
  });
  expect(
    parseArgs(
      ["push", "--no-profile", "--tunnel", "cloudflared"],
      "/workspace/project",
    ),
  ).toMatchObject({
    cmd: "push",
    profile: false,
    transport: "cloudflared",
  });
  expect(
    parseArgs(["push", "--cwd", "/workspace/other"], "/workspace/project"),
  ).toMatchObject({
    cmd: "push",
    cwd: "/workspace/other",
  });
  expect(() => parseArgs(["push", "--unknown"], "/workspace/project")).toThrow(
    "Unknown option '--unknown'",
  );
  expect(() => parseArgs(["pushh"], "/workspace/project")).toThrow(
    "Unknown command pushh",
  );
});

test("parseArgs reads the kill id from positionals regardless of flag order", () => {
  expect(parseArgs(["kill", "sbx-1"], "/workspace/project")).toMatchObject({
    cmd: "kill",
    killId: "sbx-1",
  });
  expect(
    parseArgs(["--provider", "e2b", "kill", "sbx-1"], "/workspace/project"),
  ).toMatchObject({
    cmd: "kill",
    killId: "sbx-1",
    provider: "e2b",
  });
});

test("parseArgs defaults profile and ssh to true with --no- opt-outs", () => {
  expect(parseArgs(["push"], "/workspace/project")).toMatchObject({
    profile: true,
    ssh: true,
  });
  expect(
    parseArgs(["push", "--no-profile", "--no-ssh"], "/workspace/project"),
  ).toMatchObject({
    profile: false,
    ssh: false,
  });
});

test("parseArgs reads repeated comma-split exclude and include flags", () => {
  expect(
    parseArgs(
      [
        "push",
        "--exclude",
        "node_modules,dist",
        "--exclude",
        ".cache",
        "--include",
        "/Users/alice/.cache/tool",
        "--include",
        "/opt/large,/tmp/shared",
      ],
      "/workspace/project",
    ),
  ).toMatchObject({
    excludes: ["node_modules", "dist", ".cache"],
    includes: ["/Users/alice/.cache/tool", "/opt/large", "/tmp/shared"],
  });
  expect(() => parseArgs(["push", "--exclude"], "/workspace/project")).toThrow(
    "'--exclude <value>' argument missing",
  );
  expect(() => parseArgs(["push", "--include"], "/workspace/project")).toThrow(
    "'--include <value>' argument missing",
  );
});

test("parseArgs reads setup command", () => {
  expect(parseArgs(["setup"], "/workspace/project")).toMatchObject({
    cmd: "setup",
    cwd: "/workspace/project",
    excludes: [],
    includes: [],
    provider: undefined,
    transport: undefined,
  });
});

test("parseArgs validates provider values", () => {
  expect(
    parseArgs(["push", "--provider", "e2b"], "/workspace/project"),
  ).toMatchObject({ provider: "e2b" });
  expect(
    parseArgs(["push", "--provider", "modal"], "/workspace/project"),
  ).toMatchObject({ provider: "modal" });
  expect(
    parseArgs(["push", "--provider", "daytona"], "/workspace/project"),
  ).toMatchObject({ provider: "daytona" });
  expect(
    parseArgs(["push", "--provider", "vercel"], "/workspace/project"),
  ).toMatchObject({ provider: "vercel" });
  expect(() =>
    parseArgs(["push", "--provider", "bogus"], "/workspace/project"),
  ).toThrow("--provider must be one of: e2b, modal, daytona, vercel");
  expect(() => readProvider(undefined)).toThrow(
    "pass --provider or run `sandhop setup`",
  );
});

test("parseArgs validates tunnel values", () => {
  expect(
    parseArgs(["push", "--tunnel", "public"], "/workspace/project"),
  ).toMatchObject({ transport: "public" });
  expect(() =>
    parseArgs(["push", "--tunnel", "wireguard"], "/workspace/project"),
  ).toThrow("--tunnel must be 'public' or 'cloudflared'");
  expect(() => readTransport(undefined)).toThrow(
    "pass --tunnel or run `sandhop setup`",
  );
});

test("buildTransport creates the selected transport", () => {
  expect(buildTransport("public", {}).id).toBe("public");
  expect(
    buildTransport("cloudflared", {
      token: "token",
      hostname: "sandhop.example.com",
    }).id,
  ).toBe("cloudflared");
});
