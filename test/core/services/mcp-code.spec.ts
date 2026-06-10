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
  expect(plan.installCmds).toEqual(["cd /home/user/mcp && npm ci"]);
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
args = ["-lc", "source /home/local/.config/sandhop/mcp.env && /home/local/bun-app/server.ts"]
cwd = "/home/local/bun-app"

[mcp_servers.python]
command = "uv"
args = ["run", "/home/local/py/server.py"]
cwd = "/home/local/py"
`,
      "/home/local/.config/sandhop/mcp.env": "TOKEN=value\n",
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
    "cd /home/user/bun-app && bun install --frozen-lockfile",
    "cd /home/user/py && uv sync",
  ]);
  expect(plan.rewrites[0]!.args).toEqual([
    "-lc",
    "source /home/user/.config/sandhop/mcp.env && /home/user/bun-app/server.ts",
  ]);
});

test("McpCodeService resolves bare script commands via PATH and excludes untransferable ones", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: { PATH: "/home/local/.bun/bin:/usr/local/bin:/usr/bin" },
    files: {
      "/home/local/.codex/config.toml": `
[mcp_servers.gbrain]
command = "gbrain"
args = ["serve"]

[mcp_servers.compiled]
command = "machtool"

[mcp_servers.ghost]
command = "ghost"

[mcp_servers.orphan]
command = "node"
args = ["/home/local/scripts/loose.js"]

[mcp_servers.npx]
command = "npx"
args = ["-y", "some-server"]
`,
      "/home/local/gbrain/src/cli.ts": "#!/usr/bin/env bun\nconsole.log(1)\n",
      "/home/local/gbrain/package.json": "{}",
      "/home/local/gbrain/bun.lock": "",
      "/home/local/scripts/loose.js": "#!/usr/bin/env node\n",
    },
    bytes: {
      "/usr/local/bin/machtool": new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0]),
    },
    symlinks: {
      "/home/local/.bun/bin/gbrain": "/home/local/gbrain/src/cli.ts",
    },
    execValues: {
      "git -C /home/local/gbrain/src rev-parse --show-toplevel":
        "/home/local/gbrain\n",
    },
  });

  const plan = new McpCodeService(host, CODEX).plan(
    "/workspace/project",
    "/home/user",
  );

  expect(plan.classifications).toEqual([
    { name: "gbrain", kind: "local-path" },
    { name: "compiled", kind: "excluded" },
    { name: "ghost", kind: "excluded" },
    { name: "orphan", kind: "excluded" },
    { name: "npx", kind: "remote-installable" },
  ]);
  expect(plan.excluded).toEqual([
    {
      name: "compiled",
      reason: "host-local binary (not transferable): machtool",
    },
    { name: "ghost", reason: "command not found on local PATH: ghost" },
    {
      name: "orphan",
      reason:
        "no git project root for local path: /home/local/scripts/loose.js",
    },
  ]);
  expect(plan.mappings).toEqual([
    { localPath: "/home/local/gbrain", sandboxPath: "/home/user/gbrain" },
  ]);
  expect([...plan.runtimes]).toEqual(["bun"]);
  expect(plan.installCmds).toEqual([
    "cd /home/user/gbrain && bun install --frozen-lockfile",
  ]);
  expect(plan.rewrites[0]).toEqual({
    name: "gbrain",
    transport: "stdio",
    command: "/home/user/gbrain/src/cli.ts",
    args: ["serve"],
  });
});

test("McpCodeService installs runtimes referenced inside remote-installable bash servers", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.codex/config.toml": `
[mcp_servers.workspace]
command = "bash"
args = ["-c", "set -a && source /home/local/.env.d/x.env && set +a && exec uvx --with rich some-server"]

[mcp_servers.bunbased]
command = "bash"
args = ["-lc", "exec bunx some-other-server"]
`,
      "/home/local/.env.d/x.env": "TOKEN=value\n",
    },
  });

  const plan = new McpCodeService(host, CODEX).plan(
    "/workspace/project",
    "/home/user",
  );

  expect(plan.classifications).toEqual([
    { name: "workspace", kind: "remote-installable" },
    { name: "bunbased", kind: "remote-installable" },
  ]);
  expect([...plan.runtimes].sort()).toEqual(["bun", "uv"]);
});

test("McpCodeService plan maps local project roots", () => {
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

  expect(
    new McpCodeService(host, CODEX).plan("/workspace/project", "/home/user"),
  ).toMatchObject({ mappings: [{ localPath: "/home/local/mcp" }] });
});
