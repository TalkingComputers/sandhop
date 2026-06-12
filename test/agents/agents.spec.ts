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
import { resolveSession } from "../../src/agents/index.js";
import {
  renderNodeScript,
  type NodeScript,
} from "../../src/core/sandbox-scripts.js";
import { classify } from "../../src/core/services/mcp-classify.js";
import type { ResumeSession } from "../../src/core/ports/agent.js";
import { FakeHost } from "../fakes/host.js";

const stageNodeScripts = (scripts: readonly NodeScript[]): string[] => {
  for (const script of scripts) writeFileSync(script.path, script.content);
  return scripts.flatMap(renderNodeScript);
};

test("declarative agents install exact versions and compose native resume commands", () => {
  expect(CLAUDE_CODE.installCmd("2.1.160")).toContain(
    "curl -fsSL https://claude.ai/install.sh | bash -s 2.1.160",
  );
  expect(CLAUDE_CODE.installCmd("2.1.160")).toContain(
    'export PATH="$HOME/.local/bin:$PATH"',
  );
  expect(CLAUDE_CODE.installCmd("2.1.160")).toContain(
    "Claude Code version mismatch",
  );
  const resumeOf = (sessionId: string, transcript = ""): ResumeSession => ({
    sessionId,
    transcript: new TextEncoder().encode(transcript),
  });
  expect(
    CLAUDE_CODE.resumeCmd(
      resumeOf("session-id"),
      "/home/user/project",
      undefined,
    ),
  ).toBe(
    'cd /home/user/project && export PATH="$HOME/.local/bin:$PATH" && DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1 claude --resume session-id',
  );
  expect(
    CLAUDE_CODE.resumeCmd(
      resumeOf("session-id"),
      "/home/user/project",
      "120000",
    ),
  ).toBe(
    'cd /home/user/project && export PATH="$HOME/.local/bin:$PATH" && DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1 MCP_TIMEOUT=120000 claude --resume session-id',
  );
  expect(CODEX.installCmd("0.136.0")).toContain(
    'NPM_CONFIG_PREFIX="$HOME/.local" npm i -g @openai/codex@0.136.0',
  );
  expect(CODEX.installCmd("0.136.0")).toContain(
    '"$HOME/.local/bin/codex" --version',
  );
  expect(
    CODEX.resumeCmd(resumeOf("session-id"), "/home/user/project", undefined),
  ).toBe("cd /home/user/project && codex resume session-id");
  expect(
    CODEX.resumeCmd(
      resumeOf(
        "session-id",
        '{"type":"session_meta","payload":{"model_provider":"azure"}}\n',
      ),
      "/home/user/project",
      undefined,
    ),
  ).toBe(
    "cd /home/user/project && codex -c model_provider=azure resume session-id",
  );
  expect(CLAUDE_CODE.resumeCmd(null, "/home/user/project", undefined)).toBe(
    'cd /home/user/project && export PATH="$HOME/.local/bin:$PATH" && DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1 claude',
  );
  expect(CODEX.resumeCmd(null, "/home/user/project", undefined)).toBe(
    "cd /home/user/project && codex",
  );
  expect(
    CLAUDE_CODE.resumeCmd(
      resumeOf("session;$(id)'"),
      "/tmp/proj;$(touch pwn)'",
      "1;id",
    ),
  ).toBe(
    `cd "/tmp/proj;\\$(touch pwn)'" && export PATH="$HOME/.local/bin:$PATH" && DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1 MCP_TIMEOUT=1\\;id claude --resume "session;\\$(id)'"`,
  );
  expect(
    CLAUDE_CODE.remoteTranscriptPath(
      "/root",
      "-workspace-project",
      "session-id.jsonl",
    ),
  ).toBe("/root/.claude/projects/-workspace-project/session-id.jsonl");
  expect(CLAUDE_CODE.projectMemoryPath("-workspace-project")).toBe(
    ".claude/projects/-workspace-project/memory",
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
  expect(CODEX.projectMemoryPath("-workspace-project")).toBeNull();
});

test("agent preseed runs uploaded node script bodies", () => {
  const home = mkdtempSync(join(tmpdir(), "sandhop-preseed-"));
  const pwned = join(home, "PWNED");
  const remoteProj = `x;$(touch ${pwned})'`;
  const deps = new FakeHost({ home, env: {} });
  const commands = stageNodeScripts([
    ...CLAUDE_CODE.preSeed(deps, remoteProj),
    ...CODEX.preSeed(deps, remoteProj),
  ]);
  expect(
    commands.filter((command) => command.startsWith("node /tmp/sandhop-")),
  ).toHaveLength(2);
  expect(commands.join("\n")).not.toContain("node -e");
  expect(commands.join("\n")).not.toContain("cat >");

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
    mode: "replace-mcp-section",
  });
});

test("Codex MCP rewrite preserves unmodeled server keys and collects env_vars refs", () => {
  const toml = [
    "[mcp_servers.full]",
    'command = "npx"',
    'args = ["-y", "server"]',
    "enabled = false",
    "required = true",
    "tool_timeout_sec = 120",
    'env_vars = ["PASS_ME", { name = "REMOTE_ONE", source = "remote" }]',
    'enabled_tools = ["a"]',
    "",
  ].join("\n");
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: { "/home/local/.codex/config.toml": toml },
  });

  const servers = CODEX.parseMcpServers(host, "/workspace/project");
  const config = CODEX.formatMcpConfig(servers);

  expect(servers).toEqual([
    {
      name: "full",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
      extras: {
        enabled: false,
        required: true,
        tool_timeout_sec: 120,
        env_vars: ["PASS_ME", { name: "REMOTE_ONE", source: "remote" }],
        enabled_tools: ["a"],
      },
    },
  ]);
  expect(config.content).toContain("enabled = false");
  expect(config.content).toContain("required = true");
  expect(config.content).toContain("tool_timeout_sec = 120");
  expect(config.content).toContain('enabled_tools = [ "a" ]');
  expect(config.content).toContain("PASS_ME");
  expect(config.content).not.toContain("extras");
  expect(CODEX.mcpEnvRefs(toml)).toContain("PASS_ME");
  expect(CODEX.mcpEnvRefs(toml)).toContain("REMOTE_ONE");
});

test("Codex preSeed preserves existing config and trusts the sandbox cwd", () => {
  const home = join(tmpdir(), `sandhop-codex-${Date.now()}`);
  mkdirSync(join(home, ".codex"), { recursive: true });
  const localConfig = [
    'model = "gpt-5.4"',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    "",
    "[mcp_servers.local]",
    'command = "node"',
    "",
  ].join("\n");
  writeFileSync(join(home, ".codex", "config.toml"), localConfig);
  const deps = new FakeHost({
    home,
    env: {},
    files: { [`${home}/.codex/config.toml`]: localConfig },
  });

  execFileSync(
    "bash",
    [
      "-lc",
      stageNodeScripts(CODEX.preSeed(deps, "/home/user/project")).join("\n"),
    ],
    {
      env: { HOME: home, PATH: process.env.PATH! },
    },
  );

  const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  expect(config).toContain('model = "gpt-5.4"');
  expect(config).toContain('approval_policy = "on-request"');
  expect(config).toContain('sandbox_mode = "workspace-write"');
  expect(config).toContain('cli_auth_credentials_store = "file"');
  expect(config).toContain("[mcp_servers.local]");
  expect(config).toContain(
    '[projects."/home/user/project"]\ntrust_level = "trusted"',
  );
  expect(config).not.toContain('approval_policy = "never"');
  expect(config).not.toContain('sandbox_mode = "danger-full-access"');
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
      extras: { transport: "sse" },
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
          transport: "sse",
          type: "http",
          url: "https://example.com/ignored-transport",
        },
      },
      null,
      2,
    )}\n`,
    mode: "merge-mcp-servers",
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

test("Claude MCP parsing keeps command-only servers as stdio even with remote type metadata", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude.json": JSON.stringify({
        mcpServers: {
          malformedRemote: {
            type: "http",
            command: "node",
            args: ["server.js"],
          },
        },
      }),
    },
  });

  expect(CLAUDE_CODE.parseMcpServers(host, "/workspace/project")).toEqual([
    {
      name: "malformedRemote",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
    },
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

test("Codex env refs include third-party model provider keys", () => {
  expect(
    CODEX.mcpEnvRefs(`
[model_providers.azure]
name = "Azure OpenAI"
base_url = "https://example.openai.azure.com/openai/v1"
env_key = "AZURE_OPENAI_API_KEY"
wire_api = "responses"

[model_providers.org]
base_url = "https://api.example.com/v1"
env_http_headers = { "OpenAI-Organization" = "OPENAI_ORGANIZATION" }
`),
  ).toEqual(["AZURE_OPENAI_API_KEY", "OPENAI_ORGANIZATION"]);
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

test("Codex profile ships plain and symlinked skills under .codex/skills", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    symlinks: {
      "/home/local/.codex/skills/linked": "/work/external-skill",
    },
    files: {
      "/home/local/.codex/AGENTS.md": "agents",
      "/home/local/.codex/skills/plain/SKILL.md": "Use process.env.SKILL_TOKEN",
      "/home/local/.codex/skills/git-skill/SKILL.md": "git skill",
      "/home/local/.codex/skills/git-skill/.git/config": "git",
      "/work/external-skill/SKILL.md": "Use process.env.EXTERNAL_TOKEN",
    },
  });

  expect(CODEX.profileEntries(host)).toEqual([
    ".codex/AGENTS.md",
    ".codex/skills/git-skill",
    ".codex/skills/plain",
  ]);
  expect(CODEX.externalSkills(host)).toEqual([
    { realDir: "/work/external-skill", homeRelative: ".codex/skills/linked" },
  ]);
  expect(CODEX.extraEnvRefs(host)).toEqual(["EXTERNAL_TOKEN", "SKILL_TOKEN"]);
});

test("Claude transcript trimming ignores non-user lines quoting the sandhop command", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const lines = [
    '{"type":"user","message":{"role":"user","content":"fix this"}}',
    '{"type":"assistant","message":{"role":"assistant","content":"see <command-name>/sandhop</command-name> in the plugin file"}}',
    '{"type":"user","message":{"role":"user","content":"<command-name>/sandhop</command-name>"}}',
    '{"type":"assistant","message":{"role":"assistant","content":"ok"}}',
  ];
  const transcript = `${lines.join("\n")}\n`;

  const trimmed = decoder.decode(
    CLAUDE_CODE.prepareTranscript(
      {
        home: "/home/u",
        readFile: () => null,
        walk: () => [],
        statMtimeMs: () => 0,
      },
      encoder.encode(transcript),
    ),
  );

  expect(trimmed).toBe(`${lines.slice(0, 2).join("\n")}\n`);
});

test("canResume detects conversations so /sandhop-first sessions start fresh", () => {
  const encoder = new TextEncoder();
  const metaOnly = [
    '{"type":"last-prompt","sessionId":"s"}',
    '{"type":"permission-mode","permissionMode":"bypassPermissions"}',
  ].join("\n");
  expect(CLAUDE_CODE.canResume(encoder.encode(metaOnly))).toBe(false);
  expect(CLAUDE_CODE.canResume(encoder.encode(""))).toBe(false);
  expect(
    CLAUDE_CODE.canResume(
      encoder.encode(
        `${metaOnly}\n{"type":"user","message":{"role":"user","content":"hi"}}`,
      ),
    ),
  ).toBe(true);

  const codexMeta = '{"type":"session_meta","payload":{"cwd":"/p"}}';
  expect(CODEX.canResume(encoder.encode(codexMeta))).toBe(false);
  expect(
    CODEX.canResume(
      encoder.encode(
        `${codexMeta}\n{"type":"response_item","payload":{"type":"message"}}`,
      ),
    ),
  ).toBe(true);
});

test("resolveSession chooses the agent with the newest latest session", () => {
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

  const resolved = resolveSession(
    host,
    "/workspace/project",
    undefined,
    undefined,
  );

  expect(resolved.agent.id).toBe("codex");
  expect(resolved.session.sessionId).toBe("codex-session");
  expect(resolved.detectedAgents).toEqual(["claude-code", "codex"]);
});
