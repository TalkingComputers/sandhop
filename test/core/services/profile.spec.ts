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

  expect(host.copyCalls).toEqual([
    {
      cwd: "/home/local",
      entries: [".codex/config.toml", ".codex/prompts"],
      outPath: "/tmp/profile.tgz",
    },
  ]);
});

test("ProfileService ships Claude manifests and non-reproducible skill dirs", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    symlinks: {
      "/home/local/.claude/skills/linked":
        "/home/local/.claude/skills/git/skills/linked",
    },
    files: {
      "/home/local/.claude.json": "{}",
      "/home/local/.claude/settings.json": "{}",
      "/home/local/.claude/settings.local.json": "{}",
      "/home/local/.claude/CLAUDE.md": "instructions",
      "/home/local/.claude/commands/ship.md": "ship",
      "/home/local/.claude/skills/local/SKILL.md": "local",
      "/home/local/.claude/skills/big/SKILL.md": "big",
      "/home/local/.claude/skills/git/SKILL.md": "git",
      "/home/local/.claude/skills/git/.git/config":
        '[remote "origin"]\n\turl = https://github.com/acme/gstack.git\n',
      "/home/local/.claude/skills/node/SKILL.md": "node",
      "/home/local/.claude/skills/node/node_modules/pkg/index.js": "pkg",
      "/home/local/.claude/skills/no-skill/README.md": "readme",
      "/home/local/.claude/agents/reviewer.md": "reviewer",
      "/home/local/.claude/output-styles/plain.md": "plain",
      "/home/local/.claude/plugins/known_marketplaces.json": "{}",
      "/home/local/.claude/plugins/installed_plugins.json": "{}",
      "/home/local/.claude/plugins/cache/blob": "plugin",
      "/home/local/.claude/plugins/marketplaces/official/README.md": "market",
    },
  });

  await new ProfileService(host, CLAUDE_CODE).build("/tmp/profile.tgz");

  expect(host.copyCalls[0]!.entries).toEqual([
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/CLAUDE.md",
    ".claude/commands",
    ".claude/plugins/known_marketplaces.json",
    ".claude/plugins/installed_plugins.json",
    ".claude/skills/big",
    ".claude/skills/local",
  ]);
});
