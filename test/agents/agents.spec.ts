import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CODEX } from "../../src/agents/codex.js";
import { CLAUDE_CODE } from "../../src/agents/claude-code.js";

test("declarative agents install exact versions and compose native resume commands", () => {
  expect(CLAUDE_CODE.installCmd("2.1.160")).toBe(
    "npm i -g @anthropic-ai/claude-code@2.1.160",
  );
  expect(CLAUDE_CODE.resumeCmd("session-id", "/home/user/project")).toBe(
    "cd /home/user/project && claude --resume session-id",
  );
  expect(CODEX.installCmd("0.136.0")).toBe("npm i -g @openai/codex@0.136.0");
  expect(CODEX.resumeCmd("session-id", "/home/user/project")).toBe(
    "cd /home/user/project && codex resume session-id",
  );
});

test("Codex preSeed preserves existing config and trusts the sandbox cwd", () => {
  const home = join(tmpdir(), `keepon-codex-${Date.now()}`);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5.4"\n');

  execFileSync(
    "bash",
    ["-lc", CODEX.preSeed("/home/user/project").join("\n")],
    {
      env: { HOME: home, PATH: process.env.PATH! },
    },
  );

  expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(
    '[projects."/home/user/project"]\ntrust_level = "trusted"',
  );
});
