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
      "/home/local/.claude/skills/gstack/package.json": JSON.stringify({
        scripts: { build: "tsc" },
      }),
      "/home/local/.claude/skills/gstack/package-lock.json": "",
      "/home/local/.claude/skills/gstack/skills/office-hours/SKILL.md":
        "office",
    },
    execValues: {
      "git -C /home/local/.claude/skills/gstack status --porcelain": "",
      "git -C /home/local/.claude/skills/gstack rev-parse HEAD":
        "0123456789abcdef0123456789abcdef01234567\n",
      "git -C /home/local/.claude/skills/gstack branch -r --contains 0123456789abcdef0123456789abcdef01234567":
        "  origin/main\n",
      "git -C /home/local/.claude/skills/gstack config --get remote.origin.url":
        "https://github.com/acme/gstack.git\n",
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
      'cd "$HOME/.claude/skills/gstack" && npm ci',
      'cd "$HOME/.claude/skills/gstack" && npm run build',
      'mkdir -p "$HOME/.claude/skills/office-hours" && ln -sf "$HOME/.claude/skills/gstack/skills/office-hours/SKILL.md" "$HOME/.claude/skills/office-hours/SKILL.md"',
    ],
  });
  expect(host.execCalls).toEqual([
    {
      bin: "git",
      args: [
        "-C",
        "/home/local/.claude/skills/gstack",
        "status",
        "--porcelain",
      ],
    },
    {
      bin: "git",
      args: ["-C", "/home/local/.claude/skills/gstack", "rev-parse", "HEAD"],
    },
    {
      bin: "git",
      args: [
        "-C",
        "/home/local/.claude/skills/gstack",
        "branch",
        "-r",
        "--contains",
        "0123456789abcdef0123456789abcdef01234567",
      ],
    },
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
  ]);
});

test("ReinstallService plans local skill dependency installs", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude/skills/local/SKILL.md": "local",
      "/home/local/.claude/skills/local/package.json": "{}",
      "/home/local/.claude/skills/local/package-lock.json": "",
      "/home/local/.claude/skills/plain/SKILL.md": "plain",
    },
  });

  expect(new ReinstallService(host, CLAUDE_CODE).plan().commands).toEqual([
    'cd "$HOME/.claude/skills/local" && npm ci',
  ]);
});

test("ReinstallService copies dirty and unpushed git skills instead of cloning them", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude/skills/clean/SKILL.md": "clean",
      "/home/local/.claude/skills/clean/.git": "clean",
      "/home/local/.claude/skills/dirty/SKILL.md": "dirty",
      "/home/local/.claude/skills/dirty/.git": "dirty",
      "/home/local/.claude/skills/dirty/package.json": "{}",
      "/home/local/.claude/skills/dirty/pnpm-lock.yaml": "",
      "/home/local/.claude/skills/unpushed/SKILL.md": "unpushed",
      "/home/local/.claude/skills/unpushed/.git": "unpushed",
      "/home/local/.claude/skills/unpushed/package.json": "{}",
      "/home/local/.claude/skills/unpushed/bun.lock": "",
    },
    execValues: {
      "git -C /home/local/.claude/skills/clean status --porcelain": "",
      "git -C /home/local/.claude/skills/clean rev-parse HEAD":
        "1111111111111111111111111111111111111111\n",
      "git -C /home/local/.claude/skills/clean branch -r --contains 1111111111111111111111111111111111111111":
        "  origin/main\n",
      "git -C /home/local/.claude/skills/clean config --get remote.origin.url":
        "https://github.com/acme/clean.git\n",
      "git -C /home/local/.claude/skills/dirty status --porcelain":
        " M SKILL.md\n",
      "git -C /home/local/.claude/skills/unpushed status --porcelain": "",
      "git -C /home/local/.claude/skills/unpushed rev-parse HEAD":
        "2222222222222222222222222222222222222222\n",
      "git -C /home/local/.claude/skills/unpushed branch -r --contains 2222222222222222222222222222222222222222":
        "",
    },
  });

  expect(new ReinstallService(host, CLAUDE_CODE).plan().commands).toEqual([
    "git clone 'https://github.com/acme/clean.git' \"$HOME/.claude/skills/clean\" && git -C \"$HOME/.claude/skills/clean\" checkout '1111111111111111111111111111111111111111'",
    'cd "$HOME/.claude/skills/dirty" && pnpm install --frozen-lockfile',
    'cd "$HOME/.claude/skills/unpushed" && bun install --frozen-lockfile',
  ]);
});

test("ReinstallService links directory symlink skills and installs external symlink skills", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    symlinks: {
      "/home/local/.claude/skills/linked-dir":
        "/home/local/.claude/skills/gstack/skills/linked-dir",
      "/home/local/.claude/skills/external": "/work/external-skill",
    },
    files: {
      "/home/local/.claude/skills/gstack/SKILL.md": "gstack",
      "/home/local/.claude/skills/gstack/.git": "git",
      "/home/local/.claude/skills/gstack/skills/linked-dir/SKILL.md": "linked",
      "/work/external-skill/SKILL.md": "external",
      "/work/external-skill/package.json": "{}",
      "/work/external-skill/yarn.lock": "",
    },
    execValues: {
      "git -C /home/local/.claude/skills/gstack status --porcelain": "",
      "git -C /home/local/.claude/skills/gstack rev-parse HEAD":
        "3333333333333333333333333333333333333333\n",
      "git -C /home/local/.claude/skills/gstack branch -r --contains 3333333333333333333333333333333333333333":
        "  origin/main\n",
      "git -C /home/local/.claude/skills/gstack config --get remote.origin.url":
        "https://github.com/acme/gstack.git\n",
    },
  });

  expect(new ReinstallService(host, CLAUDE_CODE).plan().commands).toEqual([
    "git clone 'https://github.com/acme/gstack.git' \"$HOME/.claude/skills/gstack\" && git -C \"$HOME/.claude/skills/gstack\" checkout '3333333333333333333333333333333333333333'",
    'cd "$HOME/.claude/skills/external" && yarn install --frozen-lockfile',
    'mkdir -p "$HOME/.claude/skills" && ln -sfn "$HOME/.claude/skills/gstack/skills/linked-dir" "$HOME/.claude/skills/linked-dir"',
  ]);
});

test("ReinstallService skips broken symlink skills", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    symlinks: {
      "/home/local/.claude/skills/broken": "/work/missing-skill",
    },
    brokenRealpaths: ["/home/local/.claude/skills/broken"],
  });

  expect(new ReinstallService(host, CLAUDE_CODE).plan()).toEqual({
    commands: [],
  });
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

test("ReinstallService treats corrupt plugin and settings JSON as absent", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude/plugins/known_marketplaces.json": JSON.stringify({
        official: {
          source: { source: "github", repo: "anthropics/claude-plugins" },
        },
      }),
      "/home/local/.claude/plugins/installed_plugins.json": "{",
      "/home/local/.claude/settings.json": "{",
    },
  });

  expect(new ReinstallService(host, CLAUDE_CODE).plan().commands).toEqual([
    "claude plugin marketplace add 'anthropics/claude-plugins'",
  ]);
});

test("ReinstallService treats corrupt marketplaces JSON as absent", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude/plugins/known_marketplaces.json": "{",
      "/home/local/.claude/plugins/installed_plugins.json": JSON.stringify({
        plugins: { "serena@official": [] },
      }),
    },
  });

  expect(new ReinstallService(host, CLAUDE_CODE).plan().commands).toEqual([
    "claude plugin install 'serena@official' --scope user",
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
