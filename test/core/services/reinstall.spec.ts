import { expect, test } from "vitest";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { CODEX } from "../../../src/agents/codex.js";
import { ReinstallService } from "../../../src/core/services/reinstall.js";
import { FakeHost } from "../../fakes/host.js";

test("ReinstallService plans marketplace, plugin, disable, git skill, and symlink rebuild commands", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    symlinks: {
      "/home/local/.claude/skills/office-hours/SKILL.md":
        "../gstack/skills/office-hours/SKILL.md",
    },
    files: {
      "/home/local/.claude/plugins/known_marketplaces.json": JSON.stringify({
        official: {
          source: { source: "github", repo: "anthropics/claude-plugins" },
        },
        internal: {
          source: { source: "git", url: "https://example.com/plugins.git" },
        },
      }),
      "/home/local/.claude/plugins/installed_plugins.json": JSON.stringify({
        version: 2,
        plugins: {
          "frontend-design@official": [{ scope: "project" }],
          "internal-tool@internal": [{ scope: "user" }],
        },
      }),
      "/home/local/.claude/settings.json": JSON.stringify({
        enabledPlugins: {
          "frontend-design@official": true,
          "serena@official": false,
        },
      }),
      "/home/local/.claude/skills/gstack/SKILL.md": "gstack",
      "/home/local/.claude/skills/gstack/.git": "gitdir",
      "/home/local/.claude/skills/gstack/skills/office-hours/SKILL.md":
        "office",
    },
    execValues: {
      "git -C /home/local/.claude/skills/gstack config --get remote.origin.url":
        "https://github.com/acme/gstack.git\n",
      "git -C /home/local/.claude/skills/gstack rev-parse HEAD":
        "0123456789abcdef0123456789abcdef01234567\n",
    },
  });

  expect(new ReinstallService(host, CLAUDE_CODE).plan()).toEqual({
    commands: [
      "claude plugin marketplace add 'anthropics/claude-plugins'",
      "claude plugin marketplace add 'https://example.com/plugins.git'",
      "claude plugin install 'frontend-design@official' --scope user",
      "claude plugin install 'internal-tool@internal' --scope user",
      "claude plugin disable 'serena@official'",
      "git clone 'https://github.com/acme/gstack.git' \"$HOME/.claude/skills/gstack\" && git -C \"$HOME/.claude/skills/gstack\" checkout '0123456789abcdef0123456789abcdef01234567'",
      'mkdir -p "$HOME/.claude/skills/office-hours" && ln -sf "$HOME/.claude/skills/gstack/skills/office-hours/SKILL.md" "$HOME/.claude/skills/office-hours/SKILL.md"',
    ],
  });
  expect(host.execCalls).toEqual([
    {
      bin: "git",
      args: [
        "-C",
        "/home/local/.claude/skills/gstack",
        "config",
        "--get",
        "remote.origin.url",
      ],
    },
    {
      bin: "git",
      args: ["-C", "/home/local/.claude/skills/gstack", "rev-parse", "HEAD"],
    },
  ]);
});

test("ReinstallService quotes marketplace and plugin metacharacters", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude/plugins/known_marketplaces.json": JSON.stringify({
        official: {
          source: { source: "git", url: "https://example.com/a;$(id)'" },
        },
      }),
      "/home/local/.claude/plugins/installed_plugins.json": JSON.stringify({
        plugins: { "plugin;$(id)'@official": [] },
      }),
      "/home/local/.claude/settings.json": JSON.stringify({
        enabledPlugins: { "disabled;$(id)'@official": false },
      }),
    },
  });

  expect(new ReinstallService(host, CLAUDE_CODE).plan().commands).toEqual([
    "claude plugin marketplace add 'https://example.com/a;$(id)'\\'''",
    "claude plugin install 'plugin;$(id)'\\''@official' --scope user",
    "claude plugin disable 'disabled;$(id)'\\''@official'",
  ]);
});

test("ReinstallService leaves Codex profiles to MCP enrichment", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude/plugins/known_marketplaces.json": JSON.stringify({
        official: {
          source: { source: "github", repo: "anthropics/claude-plugins" },
        },
      }),
    },
  });

  expect(new ReinstallService(host, CODEX).plan()).toEqual({ commands: [] });
});
