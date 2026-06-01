import { expect, test } from "vitest";
import { CODEX } from "../../../src/agents/codex.js";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { ProfileService } from "../../../src/core/services/profile.js";
import { FakeHost } from "../../fakes/host.js";

test("ProfileService ships portable Codex config without auth, caches, sessions, plugins, or secret dirs", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.codex/config.toml": 'model = "gpt-5.4"\n',
      "/home/local/.codex/prompts/review.md": "review",
      "/home/local/.codex/auth.json": "{}",
      "/home/local/.codex/sessions/rollout.jsonl": "{}",
      "/home/local/.codex/cache/blob": "cache",
      "/home/local/.secrets/openai.env": "OPENAI_API_KEY=x",
    },
  });

  await expect(
    new ProfileService(host, CODEX).build("/tmp/profile.tgz"),
  ).resolves.toBe("/tmp/profile.tgz");

  expect(host.tarCalls).toEqual([
    {
      cwd: "/home/local",
      entries: [".codex/config.toml", ".codex/prompts"],
      outPath: "/tmp/profile.tgz",
    },
  ]);
});

test("ProfileService ships Claude settings, commands, agents, plugins, and output styles only when present", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude/settings.json": "{}",
      "/home/local/.claude/commands/ship.md": "ship",
      "/home/local/.claude/agents/reviewer.md": "reviewer",
      "/home/local/.claude/output-styles/plain.md": "plain",
      "/home/local/.claude/plugins/cache/blob": "plugin",
    },
  });

  await new ProfileService(host, CLAUDE_CODE).build("/tmp/profile.tgz");

  expect(host.tarCalls[0]!.entries).toEqual([
    ".claude/settings.json",
    ".claude/commands",
    ".claude/agents",
    ".claude/output-styles",
    ".claude/plugins",
  ]);
});
