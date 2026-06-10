import { expect, test } from "vitest";
import { CODEX } from "../../../src/agents/codex.js";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { SecretsService } from "../../../src/core/services/secrets.js";
import { FakeHost } from "../../fakes/host.js";

test("SecretsService captures only MCP-referenced env vars from process env", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: { MCP_TOKEN: "secret-token", IGNORED: "ignored" },
    files: {
      "/home/local/.codex/config.toml": `[mcp_servers.fetch]
command = "npx"

[mcp_servers.fetch.env]
MCP_TOKEN = "${"${MCP_TOKEN}"}"
MISSING_TOKEN = "${"${MISSING_TOKEN}"}"
`,
    },
  });

  expect(new SecretsService(host, CODEX).collect("/workspace/project")).toEqual(
    {
      envs: {
        MCP_TOKEN: "secret-token",
      },
      files: [],
    },
  );
});

test("SecretsService excludes sandbox-owned env vars from MCP refs", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {
      AZURE_OPENAI_API_KEY: "secret",
      HOME: "/Users/alice",
      PATH: "/opt/homebrew/bin",
    },
    files: {
      "/home/local/.codex/config.toml": `[mcp_servers.fetch]
command = "source $HOME/.config/sandhop/x.env && azure-mcp"

[mcp_servers.fetch.env]
AZURE_OPENAI_API_KEY = "${"${AZURE_OPENAI_API_KEY}"}"
HOME = "${"${HOME}"}"
PATH = "${"${PATH}"}"
`,
    },
  });

  expect(new SecretsService(host, CODEX).collect("/workspace/project")).toEqual(
    {
      envs: {
        AZURE_OPENAI_API_KEY: "secret",
      },
      files: [],
    },
  );
  expect(host.execCalls).toEqual([]);
});

test("SecretsService includes MCP code env refs and referenced source files", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: { MCP_TOKEN: "secret-token", EXTRA_TOKEN: "extra-token" },
    files: {
      "/home/local/.codex/config.toml": `[mcp_servers.fetch]
command = "bash"
args = ["-lc", "source $HOME/.config/sandhop/mcp.env && fetch-mcp"]

[mcp_servers.fetch.env]
MCP_TOKEN = "${"${MCP_TOKEN}"}"
`,
      "/home/local/.config/sandhop/mcp.env": "EXTRA_TOKEN=extra-token\n",
    },
  });

  expect(new SecretsService(host, CODEX).collect("/workspace/project")).toEqual(
    {
      envs: {
        MCP_TOKEN: "secret-token",
      },
      files: [
        {
          path: "$HOME/.config/sandhop/mcp.env",
          content: "EXTRA_TOKEN=extra-token\n",
          mode: "600",
        },
      ],
    },
  );
});

test("SecretsService scans Claude MCP config files without reading secret directories", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {
      API_TOKEN: "token",
      PROJECT_SETTINGS_TOKEN: "project-settings",
      UNUSED_TOKEN: "unused",
    },
    files: {
      "/workspace/project/.mcp.json": JSON.stringify({
        mcpServers: { search: { env: { API_TOKEN: "${API_TOKEN}" } } },
      }),
      "/workspace/project/.claude/settings.json": JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "$PROJECT_SETTINGS_TOKEN" }] },
      }),
      "/home/local/.secrets/private.env": "UNUSED_TOKEN=unused",
    },
  });

  expect(
    new SecretsService(host, CLAUDE_CODE).collect("/workspace/project"),
  ).toEqual({
    envs: {
      API_TOKEN: "token",
      PROJECT_SETTINGS_TOKEN: "project-settings",
    },
    files: [],
  });
});

test("SecretsService includes enabled plugin MCP env refs", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {
      PLUGIN_TOKEN: "plugin-token",
      DISABLED_PLUGIN_TOKEN: "disabled-plugin-token",
    },
    files: {
      "/home/local/.claude/plugins/installed_plugins.json": JSON.stringify({
        version: 2,
        plugins: {
          "enabled@official": [
            {
              installPath:
                "/home/local/.claude/plugins/cache/official/enabled/1.0.0",
            },
          ],
          "disabled@official": [
            {
              installPath:
                "/home/local/.claude/plugins/cache/official/disabled/1.0.0",
            },
          ],
          "missing-path@official": [{}],
        },
      }),
      "/home/local/.claude/settings.json": JSON.stringify({
        enabledPlugins: {
          "enabled@official": true,
          "disabled@official": false,
        },
      }),
      "/home/local/.claude/plugins/cache/official/enabled/1.0.0/.mcp.json":
        JSON.stringify({
          mcpServers: {
            plugin: { env: { PLUGIN_TOKEN: "${PLUGIN_TOKEN}" } },
          },
        }),
      "/home/local/.claude/plugins/cache/official/disabled/1.0.0/.mcp.json":
        JSON.stringify({
          mcpServers: {
            plugin: {
              env: { DISABLED_PLUGIN_TOKEN: "${DISABLED_PLUGIN_TOKEN}" },
            },
          },
        }),
    },
  });

  expect(
    new SecretsService(host, CLAUDE_CODE).collect("/workspace/project"),
  ).toEqual({
    envs: {
      PLUGIN_TOKEN: "plugin-token",
    },
    files: [],
  });
});

test("SecretsService includes shipped skill env refs", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {
      SKILL_TOKEN: "skill-token",
      SCRIPT_TOKEN: "script-token",
      CLEAN_GIT_SKILL_TOKEN: "clean-git-skill-token",
      EXTERNAL_SKILL_TOKEN: "external-skill-token",
    },
    symlinks: {
      "/home/local/.claude/skills/external": "/work/external-skill",
    },
    files: {
      "/home/local/.claude/skills/local/SKILL.md":
        "Use process.env.SKILL_TOKEN",
      "/home/local/.claude/skills/local/scripts/run.ts":
        "const token = process.env.SCRIPT_TOKEN",
      "/home/local/.claude/skills/clean/SKILL.md":
        "Use process.env.CLEAN_GIT_SKILL_TOKEN",
      "/home/local/.claude/skills/clean/.git/config": "clean",
      "/work/external-skill/SKILL.md": "Use process.env.EXTERNAL_SKILL_TOKEN",
    },
    execValues: {
      "git -C /home/local/.claude/skills/clean status --porcelain": "",
      "git -C /home/local/.claude/skills/clean rev-parse HEAD":
        "1111111111111111111111111111111111111111\n",
      "git -C /home/local/.claude/skills/clean branch -r --contains 1111111111111111111111111111111111111111":
        "  origin/main\n",
    },
  });

  expect(
    new SecretsService(host, CLAUDE_CODE).collect("/workspace/project"),
  ).toEqual({
    envs: {
      EXTERNAL_SKILL_TOKEN: "external-skill-token",
      SCRIPT_TOKEN: "script-token",
      SKILL_TOKEN: "skill-token",
    },
    files: [],
  });
});

test("SecretsService skips broken symlink skills while collecting env refs", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    symlinks: {
      "/home/local/.claude/skills/broken": "/work/missing-skill",
    },
    brokenRealpaths: ["/home/local/.claude/skills/broken"],
  });

  expect(
    new SecretsService(host, CLAUDE_CODE).collect("/workspace/project"),
  ).toEqual({
    envs: {},
    files: [],
  });
});
