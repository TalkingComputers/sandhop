import { expect, test } from "vitest";
import { CODEX } from "../../../src/agents/codex.js";
import { McpCodeService } from "../../../src/core/services/mcp-code.js";
import { FakeHost } from "../../fakes/host.js";

test("McpCodeService classifies Codex MCP servers, maps local roots, and rewrites host home paths", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: { API_TOKEN: "token" },
    files: {
      "/home/local/.codex/config.toml": `
[mcp_servers.local]
command = "node"
args = ["/home/local/mcp/server.js"]
cwd = "/home/local/mcp"
env = { API_TOKEN = "${"${API_TOKEN}"}" }

[mcp_servers.npx]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem"]

[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = "REMOTE_TOKEN"
http_headers = { "X-Ref" = "${"${HEADER_TOKEN}"}" }
env_http_headers = { Authorization = "AUTH_TOKEN" }

[mcp_servers.binary]
command = "/Applications/Foo.app/Contents/MacOS/foo"
`,
      "/home/local/mcp/package.json": "{}",
      "/home/local/mcp/package-lock.json": "{}",
      "/home/local/mcp/server.js": "#!/usr/bin/env node\n",
      "/Applications/Foo.app/Contents/MacOS/foo": "binary",
    },
    execValues: {
      "git -C /home/local/mcp rev-parse --show-toplevel": "/home/local/mcp\n",
    },
  });

  const plan = new McpCodeService(host, CODEX).plan(
    "/workspace/project",
    "/home/user",
  );

  expect(plan.classifications).toEqual([
    { name: "local", kind: "local-path" },
    { name: "npx", kind: "remote-installable" },
    { name: "remote", kind: "remote-url" },
    { name: "binary", kind: "excluded" },
  ]);
  expect(plan.mappings).toEqual([
    { localPath: "/home/local/mcp", sandboxPath: "/home/user/mcp" },
  ]);
  expect(plan.rewrites).toEqual([
    {
      name: "local",
      transport: "stdio",
      command: "node",
      args: ["/home/user/mcp/server.js"],
      cwd: "/home/user/mcp",
      env: { API_TOKEN: "${API_TOKEN}" },
    },
    {
      name: "npx",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    },
    {
      name: "remote",
      transport: "http",
      url: "https://example.com/mcp",
      bearerTokenEnvVar: "REMOTE_TOKEN",
      httpHeaders: { "X-Ref": "${HEADER_TOKEN}" },
      envHttpHeaders: { Authorization: "AUTH_TOKEN" },
    },
  ]);
  expect(plan.installCmds).toEqual(["cd '/home/user/mcp' && npm ci"]);
  expect(plan.envRefs).toEqual([
    "API_TOKEN",
    "AUTH_TOKEN",
    "HEADER_TOKEN",
    "REMOTE_TOKEN",
  ]);
  expect(plan.excluded).toEqual([
    { name: "binary", reason: "path inside an app bundle" },
  ]);
});

test("McpCodeService extracts sourced files from bash MCP commands and detects bun and uv runtimes", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.codex/config.toml": `
[mcp_servers.bash]
command = "bash"
args = ["-lc", "source /home/local/.env.d/mcp.env && /home/local/bun-app/server.ts"]
cwd = "/home/local/bun-app"

[mcp_servers.python]
command = "uv"
args = ["run", "/home/local/py/server.py"]
cwd = "/home/local/py"
`,
      "/home/local/.env.d/mcp.env": "TOKEN=value\n",
      "/home/local/bun-app/package.json": "{}",
      "/home/local/bun-app/bun.lock": "",
      "/home/local/bun-app/server.ts": "#!/usr/bin/env bun\n",
      "/home/local/py/pyproject.toml": "[project]\nname='mcp'\n",
      "/home/local/py/uv.lock": "",
      "/home/local/py/server.py": "#!/usr/bin/env python\n",
    },
    execValues: {
      "git -C /home/local/bun-app rev-parse --show-toplevel":
        "/home/local/bun-app\n",
      "git -C /home/local/py rev-parse --show-toplevel": "/home/local/py\n",
    },
  });

  const plan = new McpCodeService(host, CODEX).plan(
    "/workspace/project",
    "/home/user",
  );

  expect([...plan.runtimes].sort()).toEqual(["bun", "uv"]);
  expect(plan.installCmds).toEqual([
    "cd '/home/user/bun-app' && bun install --frozen-lockfile",
    "cd '/home/user/py' && uv sync",
  ]);
  expect(plan.referencedFiles).toEqual(["/home/local/.env.d/mcp.env"]);
  expect(plan.rewrites[0]!.args).toEqual([
    "-lc",
    "source /home/user/.env.d/mcp.env && /home/user/bun-app/server.ts",
  ]);
});

test("McpCodeService builds an archive for local project roots with supplied excludes", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.codex/config.toml": `
[mcp_servers.local]
command = "node"
args = ["/home/local/mcp/server.js"]
cwd = "/home/local/mcp"
`,
      "/home/local/mcp/package.json": "{}",
      "/home/local/mcp/package-lock.json": "{}",
      "/home/local/mcp/server.js": "",
      "/home/local/mcp/node_modules/pkg/index.js": "",
    },
    execValues: {
      "git -C /home/local/mcp rev-parse --show-toplevel": "/home/local/mcp\n",
    },
  });

  await expect(
    new McpCodeService(host, CODEX).build(
      "/workspace/project",
      "/home/user",
      ["dist"],
      "/tmp/mcp-code.tgz",
    ),
  ).resolves.toMatchObject({ mappings: [{ localPath: "/home/local/mcp" }] });

  expect(host.tarCalls).toEqual([
    {
      cwd: "/home/local",
      entries: ["mcp"],
      outPath: "/tmp/mcp-code.tgz",
      excludes: ["dist"],
    },
  ]);
});
