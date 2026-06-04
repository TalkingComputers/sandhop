import { expect, test } from "vitest";
import type { McpServer } from "../../../src/core/ports/agent.js";
import { classify } from "../../../src/core/services/mcp-classify.js";
import { FakeHost } from "../../fakes/host.js";

const host = new FakeHost({ home: "/home/local", env: {} });

test("classify excludes MCP servers with localhost bindings in urls args and env values", () => {
  const servers: McpServer[] = [
    {
      name: "url",
      transport: "http",
      url: "http://localhost:5432/mcp",
    },
    {
      name: "args",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server", "postgres://user@127.0.0.1:5432/db"],
    },
    {
      name: "env",
      transport: "stdio",
      command: "npx",
      env: { DATABASE_URL: "postgres://user@[::1]:5432/db" },
    },
  ];

  expect(servers.map((server) => classify(host, server, []))).toEqual([
    {
      kind: "excluded",
      reason: "binds to localhost / loopback (unreachable from sandbox)",
    },
    {
      kind: "excluded",
      reason: "binds to localhost / loopback (unreachable from sandbox)",
    },
    {
      kind: "excluded",
      reason: "binds to localhost / loopback (unreachable from sandbox)",
    },
  ]);
});

test("classify keeps plain npx MCP servers remote-installable", () => {
  expect(
    classify(
      host,
      {
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
      },
      [],
    ),
  ).toEqual({ kind: "remote-installable" });
});
