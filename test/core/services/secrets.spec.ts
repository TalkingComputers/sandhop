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

test("SecretsService includes MCP code env refs and referenced source files", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: { MCP_TOKEN: "secret-token", EXTRA_TOKEN: "extra-token" },
    files: {
      "/home/local/.codex/config.toml": `[mcp_servers.fetch]
command = "npx"

[mcp_servers.fetch.env]
MCP_TOKEN = "${"${MCP_TOKEN}"}"
`,
      "/home/local/.env.d/mcp.env": "EXTRA_TOKEN=extra-token\n",
    },
  });

  expect(
    new SecretsService(host, CODEX).collect("/workspace/project", {
      envRefs: ["EXTRA_TOKEN"],
      referencedFiles: ["/home/local/.env.d/mcp.env"],
    }),
  ).toEqual({
    envs: {
      MCP_TOKEN: "secret-token",
      EXTRA_TOKEN: "extra-token",
    },
    files: [
      {
        path: "$HOME/.env.d/mcp.env",
        content: "EXTRA_TOKEN=extra-token\n",
      },
    ],
  });
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
    envs: {
      API_TOKEN: "token",
    },
    files: [],
  });
});
