import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { expect, test } from "vitest";
import { buildProfile, profilePaths } from "./profile.js";

const listTarEntries = async (file: string): Promise<string[]> => {
  const entries: string[] = [];
  await tar.list({ file, onReadEntry: (entry) => entries.push(entry.path) });
  return entries.sort();
};

test("profilePaths returns claude-code paths", () => {
  expect(profilePaths("claude-code")).toEqual([
    ".env.d",
    ".claude/settings.json",
    ".claude/CLAUDE.md",
    ".claude.json",
    ".claude/commands",
    ".claude/plugins",
  ]);
});

test("profilePaths returns codex paths", () => {
  expect(profilePaths("codex")).toEqual([
    ".env.d",
    ".codex/config.toml",
    ".codex/auth.json",
    ".codex/AGENTS.md",
    ".codex/instructions.md",
    ".codex/prompts",
  ]);
});

test("buildProfile returns null when no profile paths exist", async () => {
  const home = mkdtempSync(join(tmpdir(), "keepon-profile-home-"));
  const outDir = mkdtempSync(join(tmpdir(), "keepon-profile-out-"));

  await expect(buildProfile({ agent: "codex", home, outDir })).resolves.toBe(
    null,
  );
});

test("buildProfile archives existing profile paths byte-exact", async () => {
  const home = mkdtempSync(join(tmpdir(), "keepon-profile-home-"));
  const outDir = mkdtempSync(join(tmpdir(), "keepon-profile-out-"));
  const extractDir = mkdtempSync(join(tmpdir(), "keepon-profile-extract-"));
  mkdirSync(join(home, ".env.d"), { recursive: true });
  mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
  const secret = Buffer.from([0, 255, 65]);
  writeFileSync(join(home, ".env.d", "mcp.env"), secret);
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5.4"\n');
  writeFileSync(join(home, ".codex", "sessions", "ignored.jsonl"), "{}");

  const profile = await buildProfile({ agent: "codex", home, outDir });

  expect(profile).toBe(join(outDir, "profile.tgz"));
  const entries = await listTarEntries(profile!);
  expect(entries).toContain(".env.d/mcp.env");
  expect(entries).toContain(".codex/config.toml");
  expect(entries).not.toContain(".codex/sessions/ignored.jsonl");
  await tar.extract({ file: profile!, cwd: extractDir });
  expect(readFileSync(join(extractDir, ".env.d", "mcp.env"))).toEqual(secret);
});
