import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CODEX } from "../../src/agents/codex.js";
import { CLAUDE_CODE } from "../../src/agents/claude-code.js";
import { classify } from "../../src/core/services/mcp-classify.js";
import { FakeHost } from "../fakes/host.js";

test("declarative agents install exact versions and compose native resume commands", () => {
  expect(CLAUDE_CODE.installCmd("2.1.160")).toBe(
    "npm i -g @anthropic-ai/claude-code@2.1.160",
  );
  expect(CLAUDE_CODE.resumeCmd("session-id", "/home/user/project")).toBe(
    'cd "/home/user/project" && MCP_TIMEOUT=120000 claude --resume session-id',
  );
  expect(CODEX.installCmd("0.136.0")).toBe("npm i -g @openai/codex@0.136.0");
  expect(CODEX.resumeCmd("session-id", "/home/user/project")).toBe(
    'cd "/home/user/project" && codex resume session-id',
  );
});

test("Codex MCP config writes startup timeouts for every server", () => {
  const config = CODEX.formatMcpConfig([
    {
      name: "stdio",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
    },
    {
      name: "remote",
      transport: "http",
      url: "https://example.com/mcp",
    },
  ]);

  expect(config.content.split("startup_timeout_sec = 120").length - 1).toBe(2);
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

test("Claude agent parses user, project, and cwd MCP server configs", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude.json": JSON.stringify({
        mcpServers: { user: { command: "npx", args: ["user"] } },
        projects: {
          "/workspace/project": {
            mcpServers: { project: { command: "node", args: ["project.js"] } },
          },
        },
      }),
      "/workspace/project/.mcp.json": JSON.stringify({
        mcpServers: { cwd: { url: "https://example.com/mcp" } },
      }),
    },
  });

  expect(CLAUDE_CODE.parseMcpServers(host, "/workspace/project")).toEqual([
    { name: "user", transport: "stdio", command: "npx", args: ["user"] },
    {
      name: "project",
      transport: "stdio",
      command: "node",
      args: ["project.js"],
    },
    { name: "cwd", transport: "http", url: "https://example.com/mcp" },
  ]);
});

test("Codex agent parses mcp_servers TOML tables", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.codex/config.toml": `
[mcp_servers.local]
command = "node"
args = ["server.js"]
cwd = "/workspace/mcp"

[mcp_servers.local.env]
TOKEN = "${"${TOKEN}"}"

[mcp_servers.remote]
url = "https://example.com/mcp"
`,
    },
  });

  expect(CODEX.parseMcpServers(host, "/workspace/project")).toEqual([
    {
      name: "local",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      cwd: "/workspace/mcp",
      env: { TOKEN: "${TOKEN}" },
    },
    { name: "remote", transport: "http", url: "https://example.com/mcp" },
  ]);
});

test("Codex agent parses multiline args arrays before localhost classification", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.codex/config.toml": `
[mcp_servers.postgres]
command = "npx"
args = [
  "-y",
  "@modelcontextprotocol/server-postgres",
  "postgresql://user:pass@localhost:5432/app"
]
`,
    },
  });

  const server = CODEX.parseMcpServers(host, "/workspace/project")[0];
  if (server === undefined) throw new Error("Missing postgres MCP server");

  expect(server).toEqual({
    name: "postgres",
    transport: "stdio",
    command: "npx",
    args: [
      "-y",
      "@modelcontextprotocol/server-postgres",
      "postgresql://user:pass@localhost:5432/app",
    ],
  });
  expect(classify(host, server, [])).toEqual({
    kind: "excluded",
    reason: "binds to localhost / loopback (unreachable from sandbox)",
  });
});
