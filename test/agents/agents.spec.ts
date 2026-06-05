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
import { CODEX } from "../../src/agents/codex.js";
import { CLAUDE_CODE } from "../../src/agents/claude-code.js";
import { selectDefaultAgent } from "../../src/agents/index.js";
import { classify } from "../../src/core/services/mcp-classify.js";
import { FakeHost } from "../fakes/host.js";

test("declarative agents install exact versions and compose native resume commands", () => {
  expect(CLAUDE_CODE.installCmd("2.1.160")).toBe(
    "npm i -g @anthropic-ai/claude-code@2.1.160",
  );
  expect(
    CLAUDE_CODE.resumeCmd("session-id", "/home/user/project", undefined),
  ).toBe("cd '/home/user/project' && claude --resume 'session-id'");
  expect(
    CLAUDE_CODE.resumeCmd("session-id", "/home/user/project", "120000"),
  ).toBe(
    "cd '/home/user/project' && MCP_TIMEOUT='120000' claude --resume 'session-id'",
  );
  expect(CODEX.installCmd("0.136.0")).toBe("npm i -g @openai/codex@0.136.0");
  expect(CODEX.resumeCmd("session-id", "/home/user/project", undefined)).toBe(
    "cd '/home/user/project' && codex resume 'session-id'",
  );
  expect(
    CLAUDE_CODE.resumeCmd("session;$(id)'", "/tmp/proj;$(touch pwn)'", "1;id"),
  ).toBe(
    "cd '/tmp/proj;$(touch pwn)'\\''' && MCP_TIMEOUT='1;id' claude --resume 'session;$(id)'\\'''",
  );
  expect(
    CLAUDE_CODE.remoteTranscriptPath(
      "/root",
      "-workspace-project",
      "session-id.jsonl",
    ),
  ).toBe("/root/.claude/projects/-workspace-project/session-id.jsonl");
  expect(CLAUDE_CODE.projectMemoryDir("/root", "-workspace-project")).toBe(
    "/root/.claude/projects/-workspace-project/memory",
  );
  expect(
    CODEX.remoteTranscriptPath(
      "/home/vercel-sandbox",
      "-workspace-project",
      "rollout-2026-06-04T12-00-00-session-id.jsonl",
    ),
  ).toBe(
    "/home/vercel-sandbox/.codex/sessions/2026/06/04/rollout-2026-06-04T12-00-00-session-id.jsonl",
  );
  expect(
    CODEX.projectMemoryDir("/home/vercel-sandbox", "-workspace-project"),
  ).toBeNull();
});

test("agent preseed node eval commands single-quote scripts", () => {
  const home = mkdtempSync(join(tmpdir(), "sandhop-preseed-"));
  const pwned = join(home, "PWNED");
  const remoteProj = `x;$(touch ${pwned})'`;
  const commands = [
    ...CLAUDE_CODE.preSeed(remoteProj),
    ...CODEX.preSeed(remoteProj),
  ];
  const evalCommands = commands.filter((command) =>
    command.startsWith("node -e "),
  );

  expect(evalCommands).toHaveLength(2);
  expect(evalCommands.every((command) => command.startsWith("node -e '"))).toBe(
    true,
  );

  execFileSync("bash", ["-lc", commands.join("\n")], { env: { HOME: home } });

  expect(existsSync(pwned)).toBe(false);
});

test("Codex MCP config only writes startup timeouts captured from user config", () => {
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
      startupTimeoutSec: 45,
      bearerTokenEnvVar: "REMOTE_TOKEN",
      httpHeaders: { "X-Static": "static", "X-Ref": "${HEADER_TOKEN}" },
      envHttpHeaders: { Authorization: "AUTH_TOKEN" },
    },
  ]);

  expect(config).toEqual({
    path: "$HOME/.codex/config.toml",
    content: [
      "[mcp_servers.stdio]",
      'command = "npx"',
      'args = [ "-y", "server" ]',
      "",
      "[mcp_servers.remote]",
      "startup_timeout_sec = 45",
      'url = "https://example.com/mcp"',
      'bearer_token_env_var = "REMOTE_TOKEN"',
      "",
      "[mcp_servers.remote.http_headers]",
      'X-Static = "static"',
      'X-Ref = "${HEADER_TOKEN}"',
      "",
      "[mcp_servers.remote.env_http_headers]",
      'Authorization = "AUTH_TOKEN"',
      "",
      "",
    ].join("\n"),
    mode: "append",
  });
});

test("Codex preSeed preserves existing config and trusts the sandbox cwd", () => {
  const home = join(tmpdir(), `sandhop-codex-${Date.now()}`);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5.4"\n');

  execFileSync(
    "bash",
    ["-lc", CODEX.preSeed("/home/user/project").join("\n")],
    {
      env: { HOME: home, PATH: process.env.PATH! },
    },
  );

  const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  expect(config).toContain('model = "gpt-5.4"');
  expect(config).toContain('cli_auth_credentials_store = "file"');
  expect(config).toContain(
    '[projects."/home/user/project"]\ntrust_level = "trusted"',
  );
  expect(config).not.toContain("approval_policy");
  expect(config).not.toContain("sandbox_mode");
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
        mcpServers: {
          cwd: {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer ${MCP_TOKEN}" },
          },
          sse: {
            type: "sse",
            url: "https://example.com/events",
          },
          streamable: {
            type: "streamable-http",
            url: "https://example.com/streamable",
          },
          ignoredTransport: {
            transport: "sse",
            url: "https://example.com/ignored-transport",
          },
        },
      }),
    },
  });

  const servers = CLAUDE_CODE.parseMcpServers(host, "/workspace/project");

  expect(servers).toEqual([
    { name: "user", transport: "stdio", command: "npx", args: ["user"] },
    {
      name: "project",
      transport: "stdio",
      command: "node",
      args: ["project.js"],
    },
    {
      name: "cwd",
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer ${MCP_TOKEN}" },
    },
    {
      name: "sse",
      transport: "sse",
      url: "https://example.com/events",
    },
    {
      name: "streamable",
      transport: "http",
      url: "https://example.com/streamable",
    },
    {
      name: "ignoredTransport",
      transport: "http",
      url: "https://example.com/ignored-transport",
    },
  ]);
  expect(CLAUDE_CODE.formatMcpConfig(servers)).toEqual({
    path: "$HOME/.claude.json",
    content: `${JSON.stringify(
      {
        user: { type: "stdio", command: "npx", args: ["user"] },
        project: {
          type: "stdio",
          command: "node",
          args: ["project.js"],
        },
        cwd: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer ${MCP_TOKEN}" },
        },
        sse: {
          type: "sse",
          url: "https://example.com/events",
        },
        streamable: {
          type: "http",
          url: "https://example.com/streamable",
        },
        ignoredTransport: {
          type: "http",
          url: "https://example.com/ignored-transport",
        },
      },
      null,
      2,
    )}\n`,
    mode: "merge-claude-json",
  });
});

test("Claude MCP parsing skips malformed JSON files and keeps valid servers", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude.json": "[",
      "/workspace/project/.mcp.json": JSON.stringify({
        mcpServers: { cwd: { command: "node", args: ["server.js"] } },
      }),
    },
  });
  const reverseHost = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude.json": JSON.stringify({
        mcpServers: { user: { command: "npx", args: ["user"] } },
      }),
      "/workspace/project/.mcp.json": "[",
    },
  });

  expect(CLAUDE_CODE.parseMcpServers(host, "/workspace/project")).toEqual([
    { name: "cwd", transport: "stdio", command: "node", args: ["server.js"] },
  ]);
  expect(
    CLAUDE_CODE.parseMcpServers(reverseHost, "/workspace/project"),
  ).toEqual([
    { name: "user", transport: "stdio", command: "npx", args: ["user"] },
  ]);
});

test("Codex agent parses mcp_servers TOML tables", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.codex/config.toml": `
[mcp_servers.local]
startup_timeout_sec = 45
command = "node"
args = ["server.js"]
cwd = "/workspace/mcp"

[mcp_servers.local.env]
TOKEN = "${"${TOKEN}"}"

[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = "REMOTE_TOKEN"
http_headers = { "X-Static" = "static", "X-Ref" = "${"${HEADER_TOKEN}"}" }
env_http_headers = { Authorization = "AUTH_TOKEN" }
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
      startupTimeoutSec: 45,
    },
    {
      name: "remote",
      transport: "http",
      url: "https://example.com/mcp",
      bearerTokenEnvVar: "REMOTE_TOKEN",
      httpHeaders: { "X-Static": "static", "X-Ref": "${HEADER_TOKEN}" },
      envHttpHeaders: { Authorization: "AUTH_TOKEN" },
    },
  ]);
});

test("Codex env refs include MCP bearer and env header names", () => {
  expect(
    CODEX.mcpEnvRefs(`
[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = "REMOTE_TOKEN"
http_headers = { "X-Ref" = "${"${HEADER_TOKEN}"}" }
env_http_headers = { Authorization = "AUTH_TOKEN" }
`),
  ).toEqual(["AUTH_TOKEN", "HEADER_TOKEN", "REMOTE_TOKEN"]);
});

test("Codex env refs return raw refs when TOML parsing fails", () => {
  expect(CODEX.mcpEnvRefs('token = "${TOKEN}"\n[')).toEqual(["TOKEN"]);
});

test("Codex MCP parsing skips malformed TOML files and keeps valid servers", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.codex/config.toml": "[",
      "/workspace/project/.codex/config.toml": `
[mcp_servers.cwd]
command = "node"
args = ["server.js"]
`,
    },
  });
  const reverseHost = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.codex/config.toml": `
[mcp_servers.home]
command = "node"
args = ["server.js"]
`,
      "/workspace/project/.codex/config.toml": "[",
    },
  });

  expect(CODEX.parseMcpServers(host, "/workspace/project")).toEqual([
    { name: "cwd", transport: "stdio", command: "node", args: ["server.js"] },
  ]);
  expect(CODEX.parseMcpServers(reverseHost, "/workspace/project")).toEqual([
    { name: "home", transport: "stdio", command: "node", args: ["server.js"] },
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

test("selectDefaultAgent chooses the agent with the newest latest session", () => {
  const claudePath =
    "/home/local/.claude/projects/-workspace-project/claude-session.jsonl";
  const codexPath =
    "/home/local/.codex/sessions/2026/06/04/rollout-2026-06-04T12-00-00-codex-session.jsonl";
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      [claudePath]: "{}\n",
      [codexPath]: `${JSON.stringify({ payload: { cwd: "/workspace/project" } })}\n`,
    },
    mtimes: {
      [claudePath]: 10,
      [codexPath]: 20,
    },
  });

  expect(
    selectDefaultAgent(host, "/workspace/project", [CLAUDE_CODE, CODEX]).id,
  ).toBe("codex");
});
