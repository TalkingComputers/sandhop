import { expect, test } from "vitest";
import { buildTransport, parseArgs } from "../../src/cli/args.js";

test("parseArgs keeps push defaults and flags", () => {
  expect(parseArgs([], "/workspace/project")).toMatchObject({
    cmd: "push",
    cwd: "/workspace/project",
    profile: true,
    transport: "public",
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

test("parseArgs validates tunnel values", () => {
  expect(
    parseArgs(["push", "--tunnel", "public"], "/workspace/project"),
  ).toMatchObject({ transport: "public" });
  expect(() =>
    parseArgs(["push", "--tunnel", "wireguard"], "/workspace/project"),
  ).toThrow("--tunnel must be 'public' or 'cloudflared'");
});

test("buildTransport creates the selected transport", () => {
  expect(buildTransport(parseArgs([], "/workspace/project"), {}).id).toBe(
    "public",
  );
  expect(
    buildTransport(
      parseArgs(["push", "--tunnel", "cloudflared"], "/workspace/project"),
      {
        CLOUDFLARE_TUNNEL_TOKEN: "token",
        CLOUDFLARE_TUNNEL_HOSTNAME: "keepon.example.com",
      },
    ).id,
  ).toBe("cloudflared");
});
