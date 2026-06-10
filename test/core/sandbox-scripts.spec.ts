import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  buildClaudePreSeedScript,
  buildCodexMcpConfigScript,
  buildHomeWriteScript,
  buildMergeClaudeMcpScript,
} from "../../src/core/sandbox-scripts.js";

interface ClaudeJson {
  customApiKeyResponses: { approved: string[]; rejected: string[] };
  hasCompletedOnboarding: boolean;
  mcpServers: Record<string, unknown>;
  projects: Record<
    string,
    {
      hasCompletedProjectOnboarding: boolean;
      hasTrustDialogAccepted: boolean;
    }
  >;
}

interface ClaudeMcpJson {
  hasCompletedOnboarding: boolean;
  mcpServers: Record<string, unknown>;
}

const runNodeScript = (script: string, env: Record<string, string>): void => {
  execFileSync(process.execPath, ["-e", script], {
    env: { ...process.env, ...env },
  });
};

test("buildClaudePreSeedScript merges onboarding and trust while preserving Claude JSON", () => {
  const home = mkdtempSync(join(tmpdir(), "sandhop-claude-preseed-"));
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      customApiKeyResponses: { approved: ["real"], rejected: ["old"] },
      mcpServers: { keep: { command: "node" } },
    }),
  );

  runNodeScript(
    buildClaudePreSeedScript("/workspace/project", {
      allowedTools: ["Bash(npm test)"],
      hasTrustDialogAccepted: false,
    }),
    {
      ANTHROPIC_API_KEY: "proxy-key",
      HOME: home,
    },
  );

  const parsed = JSON.parse(
    readFileSync(join(home, ".claude.json"), "utf8"),
  ) as ClaudeJson;
  expect(existsSync(join(home, ".claude.json.sandhop.tmp"))).toBe(false);
  expect(parsed.hasCompletedOnboarding).toBe(true);
  expect(parsed.projects["/workspace/project"]).toEqual({
    allowedTools: ["Bash(npm test)"],
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  });
  expect(parsed.customApiKeyResponses).toEqual({
    approved: ["real", "proxy-key"],
    rejected: ["old"],
  });
  expect(parsed.mcpServers).toEqual({ keep: { command: "node" } });
});

test("buildClaudePreSeedScript does not duplicate approved API key suffixes", () => {
  const home = mkdtempSync(join(tmpdir(), "sandhop-claude-preseed-"));
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      customApiKeyResponses: { approved: ["12345678901234567890"] },
    }),
  );

  runNodeScript(buildClaudePreSeedScript("/workspace/project", {}), {
    ANTHROPIC_API_KEY: "prefix-12345678901234567890",
    HOME: home,
  });

  const parsed = JSON.parse(
    readFileSync(join(home, ".claude.json"), "utf8"),
  ) as ClaudeJson;
  expect(parsed.customApiKeyResponses).toEqual({
    approved: ["12345678901234567890"],
    rejected: [],
  });
});

test("buildHomeWriteScript atomically writes home-relative files and creates parent dirs", () => {
  const home = mkdtempSync(join(tmpdir(), "sandhop-home-write-"));
  const content = 'model = "gpt-5.4"\nweird = "quote\'s ; $(touch pwn)"\n';

  runNodeScript(buildHomeWriteScript(".codex/config.toml", content), {
    HOME: home,
  });

  expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(
    content,
  );
  expect(existsSync(join(home, ".codex", "config.toml.sandhop.tmp"))).toBe(
    false,
  );
  expect(existsSync(join(home, "pwn"))).toBe(false);
});

test("buildCodexMcpConfigScript replaces stale Codex MCP tables", () => {
  const home = mkdtempSync(join(tmpdir(), "sandhop-prune-mcp-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  const config = join(home, ".codex", "config.toml");
  writeFileSync(
    config,
    [
      'model = "gpt-5.4"',
      "",
      "[mcp_servers.local]",
      'command = "node"',
      "",
      "[mcp_servers.local.env]",
      'TOKEN = "value"',
      "",
      '[projects."/workspace/project"]',
      'trust_level = "trusted"',
      "",
    ].join("\n"),
  );

  runNodeScript(
    buildCodexMcpConfigScript(
      config,
      ["[mcp_servers.fresh]", 'command = "node"', ""].join("\n"),
    ),
    {
      HOME: home,
    },
  );

  expect(readFileSync(config, "utf8")).toBe(
    [
      'model = "gpt-5.4"',
      "",
      '[projects."/workspace/project"]',
      'trust_level = "trusted"',
      "[mcp_servers.fresh]",
      'command = "node"',
      "",
    ].join("\n"),
  );
  expect(existsSync(`${config}.sandhop.tmp`)).toBe(false);
});

test("buildMergeClaudeMcpScript sets mcpServers and preserves existing fields", () => {
  const home = mkdtempSync(join(tmpdir(), "sandhop-merge-claude-mcp-"));
  const config = join(home, ".claude.json");
  writeFileSync(config, JSON.stringify({ hasCompletedOnboarding: true }));

  runNodeScript(
    buildMergeClaudeMcpScript(
      config,
      JSON.stringify({ local: { command: "node", args: ["server.js"] } }),
    ),
    { HOME: home },
  );

  const parsed = JSON.parse(readFileSync(config, "utf8")) as ClaudeMcpJson;
  expect(existsSync(`${config}.sandhop.tmp`)).toBe(false);
  expect(parsed.hasCompletedOnboarding).toBe(true);
  expect(parsed.mcpServers).toEqual({
    local: { command: "node", args: ["server.js"] },
  });
});
