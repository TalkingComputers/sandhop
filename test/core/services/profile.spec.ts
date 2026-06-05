import { expect, test } from "vitest";
import { CODEX } from "../../../src/agents/codex.js";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { ProfileService } from "../../../src/core/services/profile.js";
import { FakeHost } from "../../fakes/host.js";

test("ProfileService ships portable Codex profile without auth, config, caches, sessions, plugins, or secret dirs", async () => {
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
    new ProfileService(host, CODEX).build("/tmp/profile.tgz", []),
  ).resolves.toBe("/tmp/profile.tgz");

  expect(host.copyCalls).toEqual([
    {
      cwd: "/home/local",
      entries: [".codex/prompts"],
      outPath: "/tmp/profile.tgz",
      excludes: [],
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
    execValues: {
      "git -C /home/local/.claude/skills/git status --porcelain": "",
      "git -C /home/local/.claude/skills/git rev-parse HEAD":
        "0123456789abcdef0123456789abcdef01234567\n",
      "git -C /home/local/.claude/skills/git branch -r --contains 0123456789abcdef0123456789abcdef01234567":
        "  origin/main\n",
    },
  });

  await new ProfileService(host, CLAUDE_CODE).build("/tmp/profile.tgz", [
    "dist",
  ]);

  expect(host.copyCalls[0]!.entries).toEqual([
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/CLAUDE.md",
    ".claude/commands",
    ".claude/agents",
    ".claude/output-styles",
    ".claude/plugins/known_marketplaces.json",
    ".claude/plugins/installed_plugins.json",
    ".claude/skills/big",
    ".claude/skills/local",
    ".claude/skills/node",
  ]);
  expect(host.copyCalls[0]!.excludes).toEqual(["dist"]);
});

test("ProfileService ships dirty and unpushed git skills as local skill dirs", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude/skills/clean/SKILL.md": "clean",
      "/home/local/.claude/skills/clean/.git/config": "clean",
      "/home/local/.claude/skills/dirty/SKILL.md": "dirty",
      "/home/local/.claude/skills/dirty/.git/config": "dirty",
      "/home/local/.claude/skills/unpushed/SKILL.md": "unpushed",
      "/home/local/.claude/skills/unpushed/.git/config": "unpushed",
    },
    execValues: {
      "git -C /home/local/.claude/skills/clean status --porcelain": "",
      "git -C /home/local/.claude/skills/clean rev-parse HEAD":
        "1111111111111111111111111111111111111111\n",
      "git -C /home/local/.claude/skills/clean branch -r --contains 1111111111111111111111111111111111111111":
        "  origin/main\n",
      "git -C /home/local/.claude/skills/dirty status --porcelain":
        " M SKILL.md\n",
      "git -C /home/local/.claude/skills/unpushed status --porcelain": "",
      "git -C /home/local/.claude/skills/unpushed rev-parse HEAD":
        "2222222222222222222222222222222222222222\n",
      "git -C /home/local/.claude/skills/unpushed branch -r --contains 2222222222222222222222222222222222222222":
        "",
    },
  });

  await new ProfileService(host, CLAUDE_CODE).build("/tmp/profile.tgz", []);

  expect(host.copyCalls[0]!.entries).toEqual([
    ".claude/skills/dirty",
    ".claude/skills/unpushed",
  ]);
});

test("ProfileService dereferences external symlink skills into the skill name", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    symlinks: {
      "/home/local/.claude/skills/external": "/work/external-skill",
    },
    files: {
      "/work/external-skill/SKILL.md": "external",
      "/work/external-skill/bin/run.js": "run",
      "/work/external-skill/dist/out.js": "out",
    },
  });

  await new ProfileService(host, CLAUDE_CODE).build("/tmp/profile.tgz", [
    "dist",
  ]);

  expect(host.copyCalls).toEqual([
    {
      cwd: "/work/external-skill",
      entries: ["."],
      outPath: "/tmp/profile.tgz/.claude/skills/external",
      excludes: ["dist"],
    },
  ]);
  expect(
    host.exists("/tmp/profile.tgz/.claude/skills/external/bin/run.js"),
  ).toBe(true);
  expect(
    host.exists("/tmp/profile.tgz/.claude/skills/external/dist/out.js"),
  ).toBe(false);
});

test("ProfileService skips broken symlink skills", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    symlinks: {
      "/home/local/.claude/skills/broken": "/work/missing-skill",
    },
    brokenRealpaths: ["/home/local/.claude/skills/broken"],
  });

  expect(
    new ProfileService(host, CLAUDE_CODE).listExternalSymlinkSkills(),
  ).toEqual([]);
  await expect(
    new ProfileService(host, CLAUDE_CODE).build("/tmp/profile.tgz", []),
  ).resolves.toBe(null);
  expect(host.copyCalls).toEqual([]);
});
