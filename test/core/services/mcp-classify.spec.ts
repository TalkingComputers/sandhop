import { expect, test } from "vitest";
import type { McpServer } from "../../../src/core/ports/agent.js";
import {
  classify,
  installCmd,
} from "../../../src/core/services/mcp-classify.js";
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
  const classification = classify(
    host,
    {
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    },
    [],
  );

  expect(classification).toEqual({ kind: "remote-installable" });
  expect("reason" in classification).toBe(false);
});

test("installCmd chooses JavaScript install command from the root lockfile", () => {
  const cases: [string, string[], string[]][] = [
    [
      "pnpm",
      ["package.json", "pnpm-lock.yaml"],
      ["cd '/home/user/app' && pnpm install --frozen-lockfile"],
    ],
    [
      "yarn",
      ["package.json", "yarn.lock"],
      ["cd '/home/user/app' && yarn install --frozen-lockfile"],
    ],
    [
      "npm",
      ["package.json", "package-lock.json"],
      ["cd '/home/user/app' && npm ci"],
    ],
    [
      "bun",
      ["package.json", "bun.lockb"],
      ["cd '/home/user/app' && bun install --frozen-lockfile"],
    ],
    ["none", ["package.json"], []],
  ];

  for (const [name, files, expected] of cases) {
    const testHost = new FakeHost({
      home: "/home/local",
      env: {},
      files: Object.fromEntries(
        files.map((file) => [`/home/local/${name}/${file}`, ""]),
      ),
    });
    expect(
      installCmd(testHost, `/home/local/${name}`, "/home/user/app"),
    ).toEqual(expected);
  }
});

test("installCmd chooses Python install command from the root lockfile", () => {
  const cases: [string, string[], string[]][] = [
    ["poetry", ["poetry.lock"], ["cd '/home/user/app' && poetry install"]],
    ["pdm", ["pdm.lock"], ["cd '/home/user/app' && pdm install"]],
    ["uv", ["uv.lock"], ["cd '/home/user/app' && uv sync"]],
    [
      "requirements",
      ["requirements.txt"],
      ["cd '/home/user/app' && uv pip install -r requirements.txt --system"],
    ],
    ["pyproject", ["pyproject.toml"], []],
  ];

  for (const [name, files, expected] of cases) {
    const testHost = new FakeHost({
      home: "/home/local",
      env: {},
      files: Object.fromEntries(
        files.map((file) => [`/home/local/${name}/${file}`, ""]),
      ),
    });
    expect(
      installCmd(testHost, `/home/local/${name}`, "/home/user/app"),
    ).toEqual(expected);
  }
});

test("installCmd quotes sandbox roots with metacharacters", () => {
  const testHost = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/app/package.json": "",
      "/home/local/app/package-lock.json": "",
    },
  });

  expect(
    installCmd(testHost, "/home/local/app", "/home/user/app;$(touch pwn)'"),
  ).toEqual(["cd '/home/user/app;$(touch pwn)'\\''' && npm ci"]);
});
