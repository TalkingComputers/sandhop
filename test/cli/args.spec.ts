import { expect, test } from "vitest";
import {
  buildTransport,
  parseArgs,
  parseEnrichArgs,
  readProvider,
  readTransport,
} from "../../src/cli/args.js";

test("parseArgs keeps push defaults and flags", () => {
  expect(parseArgs([], "/workspace/project")).toMatchObject({
    cmd: "push",
    cwd: "/workspace/project",
    profile: true,
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
});

test("parseArgs reads setup command", () => {
  expect(parseArgs(["setup"], "/workspace/project")).toMatchObject({
    cmd: "setup",
    cwd: "/workspace/project",
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

test("parseEnrichArgs reads required enrich flags", () => {
  expect(
    parseEnrichArgs([
      "--sandbox-id",
      "sbx-1",
      "--agent",
      "codex",
      "--cwd",
      "/workspace/project",
      "--provider",
      "modal",
      "--no-profile",
      "--strict",
    ]),
  ).toEqual({
    sandboxId: "sbx-1",
    agent: "codex",
    cwd: "/workspace/project",
    provider: "modal",
    profile: false,
    strict: true,
  });
  expect(() => parseEnrichArgs([])).toThrow("--sandbox-id is required");
});

test("buildTransport creates the selected transport", () => {
  expect(buildTransport({ transport: "public" }, {}).id).toBe("public");
  expect(
    buildTransport(
      { transport: "cloudflared" },
      {
        CLOUDFLARE_TUNNEL_TOKEN: "token",
        CLOUDFLARE_TUNNEL_HOSTNAME: "sandhop.example.com",
      },
    ).id,
  ).toBe("cloudflared");
});
