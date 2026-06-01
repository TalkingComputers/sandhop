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
      MCP_TOKEN: "secret-token",
    },
  );
});

test("SecretsService scans Claude MCP config files without reading secret directories", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: { API_TOKEN: "token", UNUSED_TOKEN: "unused" },
    files: {
      "/workspace/project/.mcp.json": JSON.stringify({
        mcpServers: { search: { env: { API_TOKEN: "${API_TOKEN}" } } },
      }),
      "/home/local/.secrets/private.env": "UNUSED_TOKEN=unused",
    },
  });

  expect(
    new SecretsService(host, CLAUDE_CODE).collect("/workspace/project"),
  ).toEqual({
    API_TOKEN: "token",
  });
});
