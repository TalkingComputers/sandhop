import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  configPath,
  saveConfig,
  type KeeponConfig,
} from "../../src/cli/config.js";
import { runSetup } from "../../src/cli/setup.js";

const promptMocks = vi.hoisted(() => {
  const cancel = Symbol("cancel");
  return {
    cancel,
    confirm: vi.fn(),
    intro: vi.fn(),
    isCancel: vi.fn((value: unknown): boolean => value === cancel),
    multiselect: vi.fn(),
    note: vi.fn(),
    outro: vi.fn(),
    password: vi.fn(),
    select: vi.fn(),
    text: vi.fn(),
  };
});

vi.mock("@clack/prompts", () => ({
  confirm: promptMocks.confirm,
  intro: promptMocks.intro,
  isCancel: promptMocks.isCancel,
  multiselect: promptMocks.multiselect,
  note: promptMocks.note,
  outro: promptMocks.outro,
  password: promptMocks.password,
  select: promptMocks.select,
  text: promptMocks.text,
}));

let previousXdgConfigHome: string | undefined;

const storedConfig = (): KeeponConfig => ({
  defaultProvider: "e2b",
  transport: "cloudflared",
  cloudflare: {
    token: "stored-cloudflare-token",
    hostname: "stored.example.com",
  },
  credentials: {
    E2B_API_KEY: "stored-e2b-key",
  },
});

const readSavedConfig = (home: string): KeeponConfig =>
  JSON.parse(readFileSync(configPath(home), "utf8")) as KeeponConfig;

beforeEach(() => {
  previousXdgConfigHome = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = mkdtempSync(
    join(tmpdir(), "keepon-config-"),
  );
  promptMocks.confirm.mockReset();
  promptMocks.intro.mockReset();
  promptMocks.isCancel.mockReset();
  promptMocks.isCancel.mockImplementation(
    (value: unknown): boolean => value === promptMocks.cancel,
  );
  promptMocks.multiselect.mockReset();
  promptMocks.note.mockReset();
  promptMocks.outro.mockReset();
  promptMocks.password.mockReset();
  promptMocks.select.mockReset();
  promptMocks.text.mockReset();
});

afterEach(() => {
  if (previousXdgConfigHome === undefined)
    delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previousXdgConfigHome;
});

test("runSetup keeps stored credentials when clack returns undefined for a blank credential prompt", async () => {
  const home = mkdtempSync(join(tmpdir(), "keepon-home-"));
  saveConfig(home, storedConfig());
  promptMocks.multiselect.mockResolvedValue(["e2b"]);
  promptMocks.password.mockResolvedValue(undefined);
  promptMocks.select
    .mockResolvedValueOnce("e2b")
    .mockResolvedValueOnce("public");

  await runSetup({ home, env: {} });

  expect(readSavedConfig(home).credentials.E2B_API_KEY).toBe("stored-e2b-key");
});

test("runSetup keeps stored Cloudflare values when clack returns undefined for blank prompts", async () => {
  const home = mkdtempSync(join(tmpdir(), "keepon-home-"));
  saveConfig(home, storedConfig());
  promptMocks.multiselect.mockResolvedValue(["e2b"]);
  promptMocks.password
    .mockResolvedValueOnce("fresh-e2b-key")
    .mockResolvedValueOnce(undefined);
  promptMocks.select
    .mockResolvedValueOnce("e2b")
    .mockResolvedValueOnce("cloudflared");
  promptMocks.confirm.mockResolvedValue(true);
  promptMocks.text.mockResolvedValue(undefined);

  await runSetup({ home, env: {} });

  expect(readSavedConfig(home).cloudflare).toEqual({
    token: "stored-cloudflare-token",
    hostname: "stored.example.com",
  });
});
