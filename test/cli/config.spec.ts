import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  configPath,
  loadConfig,
  saveConfig,
  type SandhopConfig,
} from "../../src/cli/config.js";

const tempRoots: string[] = [];

const makeHome = (): string => {
  const root = mkdtempSync(join(tmpdir(), "sandhop-config-"));
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
  const config: SandhopConfig = {
    defaultProvider: "modal",
    transport: "cloudflared",
    cloudflare: { token: "cf-token", hostname: "term.example.com" },
    credentials: {
      MODAL_TOKEN_ID: "token-id",
      MODAL_TOKEN_SECRET: "token-secret",
    },
  };

  saveConfig(home, config);

  expect(statSync(join(xdg, "sandhop")).mode & 0o777).toBe(0o700);
  expect(statSync(join(xdg, "sandhop", "config.json")).mode & 0o777).toBe(
    0o600,
  );
  expect(loadConfig(home)).toEqual(config);
});

test("loadConfig returns null when the config file is missing", () => {
  expect(loadConfig(makeHome())).toBeNull();
});

test("loadConfig throws a friendly error on invalid JSON", () => {
  const home = makeHome();
  const path = configPath(home);
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, "{");

  expect(() => loadConfig(home)).toThrow(`Invalid sandhop config at ${path}`);
});

test("loadConfig throws a friendly error on wrong-shaped JSON", () => {
  const home = makeHome();
  const path = configPath(home);
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      defaultProvider: "bogus",
      transport: "ssh",
      credentials: { E2B_API_KEY: 1 },
    }),
  );

  expect(() => loadConfig(home)).toThrow(`Invalid sandhop config at ${path}`);
});

test("loadConfig rejects missing and non-string credentials", () => {
  const home = makeHome();
  const path = configPath(home);
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });

  for (const text of [
    JSON.stringify({ defaultProvider: "e2b", transport: "public" }),
    JSON.stringify({
      defaultProvider: "e2b",
      transport: "public",
      credentials: { E2B_API_KEY: 1 },
    }),
  ]) {
    writeFileSync(path, text);
    expect(() => loadConfig(home)).toThrow(`Invalid sandhop config at ${path}`);
  }
});

test("config module does not mutate the process environment", () => {
  const source = readFileSync("src/cli/config.ts", "utf8");

  expect(source).not.toContain("applyConfigToEnv");
  expect(source).not.toContain("env[key] =");
});
