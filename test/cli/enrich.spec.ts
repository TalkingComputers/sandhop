import { expect, test } from "vitest";
import { enrichSandbox } from "../../src/cli/enrich.js";
import { FakeHost } from "../fakes/host.js";
import { FakeProvider } from "../fakes/provider.js";

test("enrichSandbox sends profile and MCP roots with TransferService, uploads sourced files, writes config, and marks completion", async () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.codex/config.toml": `
[mcp_servers.local]
command = "node"
args = ["/home/local/mcp/server.js"]
cwd = "/home/local/mcp"

[mcp_servers.bash]
command = "bash"
args = ["-lc", "source /home/local/.env.d/mcp.env && /home/local/mcp/server.js"]
cwd = "/home/local/mcp"
`,
      "/home/local/.env.d/mcp.env": "TOKEN=value\n",
      "/home/local/mcp/package.json": "{}",
      "/home/local/mcp/package-lock.json": "{}",
      "/home/local/mcp/server.js": "",
    },
  });
  const provider = new FakeProvider();

  await enrichSandbox(
    {
      sandboxId: "sbx-1",
      agent: "codex",
      cwd: "/workspace/project",
      profile: true,
    },
    host,
    provider.sandbox,
  );

  expect(provider.sandbox.pathUploads).toEqual(
    expect.arrayContaining([
      {
        remotePath: expect.stringMatching(
          /\/tmp\/keepon-profile-.+\.part\.000000$/,
        ),
        localPath: expect.stringMatching(
          /\/tmp\/keepon-profile-.+\.part\.000000$/,
        ),
      },
      {
        remotePath: expect.stringMatching(
          /\/tmp\/keepon-mcp-0-.+\.part\.000000$/,
        ),
        localPath: expect.stringMatching(
          /\/tmp\/keepon-mcp-0-.+\.part\.000000$/,
        ),
      },
    ]),
  );
  const enrichmentExec = provider.sandbox.execs.find((cmd) =>
    cmd.includes("/tmp/keepon-enriched"),
  );
  expect(provider.sandbox.uploads).toContainEqual({
    path: "/home/user/.env.d/mcp.env",
    data: "TOKEN=value\n",
  });
  expect(enrichmentExec).toContain("cd /home/user/mcp && npm ci");
  expect(enrichmentExec).toContain('cat >> "$HOME/.codex/config.toml"');
  expect(enrichmentExec).toContain("/home/user/mcp/server.js");
});
