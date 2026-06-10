import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { installCommands } from "../../src/cli/install-command.js";

const EXPECTED_CLAUDE_COMMAND = readFileSync(
  new URL("../../plugin/commands/sandhop.md", import.meta.url),
  "utf8",
);

const EXPECTED_CODEX_SKILL = readFileSync(
  new URL("../../plugin/skills/sandhop/SKILL.md", import.meta.url),
  "utf8",
);

const tempRoots: string[] = [];

const makeHome = (): string => {
  const root = mkdtempSync(join(tmpdir(), "sandhop-install-"));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true });
});

test("installCommands writes the Claude Code slash command and Codex skill when agent homes exist", () => {
  const home = makeHome();
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".codex"));

  expect(installCommands(home)).toEqual(["Claude Code", "Codex"]);
  expect(
    readFileSync(join(home, ".claude", "commands", "sandhop.md"), "utf8"),
  ).toBe(EXPECTED_CLAUDE_COMMAND);
  expect(
    readFileSync(join(home, ".codex", "skills", "sandhop", "SKILL.md"), "utf8"),
  ).toBe(EXPECTED_CODEX_SKILL);
});

test("installCommands removes a stale Codex prompt from the deprecated prompts dir", () => {
  const home = makeHome();
  mkdirSync(join(home, ".codex", "prompts"), { recursive: true });
  writeFileSync(join(home, ".codex", "prompts", "sandhop.md"), "old");

  expect(installCommands(home)).toEqual(["Codex"]);
  expect(existsSync(join(home, ".codex", "prompts", "sandhop.md"))).toBe(false);
  expect(
    existsSync(join(home, ".codex", "skills", "sandhop", "SKILL.md")),
  ).toBe(true);
});

test("installCommands writes only detected agents and never creates missing agent roots", () => {
  const home = makeHome();
  mkdirSync(join(home, ".claude"));

  expect(installCommands(home)).toEqual(["Claude Code"]);
  expect(existsSync(join(home, ".claude", "commands", "sandhop.md"))).toBe(
    true,
  );
  expect(existsSync(join(home, ".codex"))).toBe(false);
});

test("installCommands returns an empty list when no agent home exists", () => {
  const home = makeHome();

  expect(installCommands(home)).toEqual([]);
  expect(existsSync(join(home, ".claude"))).toBe(false);
  expect(existsSync(join(home, ".codex"))).toBe(false);
});
