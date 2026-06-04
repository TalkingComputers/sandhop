import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  applyConfigToEnv,
  loadConfig,
  saveConfig,
  type KeeponConfig,
} from "../../src/cli/config.js";

const tempRoots: string[] = [];

const makeHome = (): string => {
  const root = mkdtempSync(join(tmpdir(), "keepon-config-"));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  delete process.env["XDG_CONFIG_HOME"];
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true });
});

test("saveConfig writes private dir and file permissions and loadConfig round-trips", () => {
  const home = makeHome();
  const xdg = join(home, "xdg");
  process.env["XDG_CONFIG_HOME"] = xdg;
  const config: KeeponConfig = {
    defaultProvider: "modal",
    transport: "cloudflared",
    cloudflare: { token: "cf-token", hostname: "term.example.com" },
    credentials: {
      MODAL_TOKEN_ID: "token-id",
      MODAL_TOKEN_SECRET: "token-secret",
    },
  };

  saveConfig(home, config);

  expect(statSync(join(xdg, "keepon")).mode & 0o777).toBe(0o700);
  expect(statSync(join(xdg, "keepon", "config.json")).mode & 0o777).toBe(0o600);
  expect(loadConfig(home)).toEqual(config);
});

test("loadConfig returns null when the config file is missing", () => {
  expect(loadConfig(makeHome())).toBeNull();
});

test("applyConfigToEnv sets missing values, preserves existing values, and applies defaults", () => {
  const env: Record<string, string | undefined> = {
    E2B_API_KEY: "env-key",
    KEEPON_PROVIDER: "vercel",
    KEEPON_TRANSPORT: "public",
    CLOUDFLARE_TUNNEL_TOKEN: "env-token",
  };

  applyConfigToEnv(
    {
      defaultProvider: "e2b",
      transport: "cloudflared",
      cloudflare: { token: "stored-token", hostname: "term.example.com" },
      credentials: {
        E2B_API_KEY: "stored-key",
        MODAL_TOKEN_ID: "token-id",
      },
    },
    env,
  );

  expect(env).toEqual({
    E2B_API_KEY: "env-key",
    KEEPON_PROVIDER: "vercel",
    KEEPON_TRANSPORT: "public",
    CLOUDFLARE_TUNNEL_TOKEN: "env-token",
    CLOUDFLARE_TUNNEL_HOSTNAME: "term.example.com",
    MODAL_TOKEN_ID: "token-id",
  });
});
