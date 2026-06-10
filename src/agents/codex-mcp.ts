import { collectEnvRefs } from "../core/env.js";
import type {
  AgentMcpDeps,
  McpConfigWrite,
  McpServer,
} from "../core/ports/agent.js";
import { parse, stringify, type TomlTable, type TomlValue } from "smol-toml";
import {
  collectEnvRefsFromValue,
  isTomlTable,
  toTomlNumber,
  toTomlString,
  toTomlStringArray,
  toTomlStringRecord,
  toTomlTable,
} from "./codex-toml.js";

export const readTomlEnvRefs = (text: string): string[] => {
  const refs = new Set<string>();
  for (const name of collectEnvRefs(text)) refs.add(name);
  let parsed: TomlTable;
  try {
    parsed = parse(text);
  } catch {
    return [...refs].sort();
  }
  const mcpServers = toTomlTable(parsed.mcp_servers, "mcp_servers");
  if (mcpServers !== undefined)
    for (const [name, value] of Object.entries(mcpServers)) {
      const server = toTomlTable(value, `mcp_servers.${name}`);
      if (server === undefined) throw new Error(`Expected mcp_servers.${name}`);
      const env = toTomlTable(server.env, `mcp_servers.${name}.env`);
      if (env !== undefined) for (const key of Object.keys(env)) refs.add(key);
      const envVars = server.env_vars;
      if (Array.isArray(envVars))
        for (const item of envVars) {
          if (typeof item === "string") refs.add(item);
          else if (isTomlTable(item) && typeof item.name === "string")
            refs.add(item.name);
        }
      const bearerTokenEnvVar = toTomlString(
        server.bearer_token_env_var,
        `mcp_servers.${name}.bearer_token_env_var`,
      );
      if (bearerTokenEnvVar !== undefined) refs.add(bearerTokenEnvVar);
      const envHttpHeaders = toTomlStringRecord(
        server.env_http_headers,
        `mcp_servers.${name}.env_http_headers`,
      );
      if (envHttpHeaders !== undefined)
        for (const value of Object.values(envHttpHeaders)) refs.add(value);
    }
  for (const value of Object.values(parsed))
    collectEnvRefsFromValue(refs, value);
  return [...refs].sort();
};

const CONSUMED_SERVER_KEYS = new Set([
  "args",
  "bearer_token_env_var",
  "command",
  "cwd",
  "env",
  "env_http_headers",
  "http_headers",
  "startup_timeout_sec",
  "url",
]);

const collectExtras = (
  table: TomlTable,
): Record<string, unknown> | undefined => {
  const entries = Object.entries(table).filter(
    ([key]) => !CONSUMED_SERVER_KEYS.has(key),
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

export const toMcpServer = (
  name: string,
  value: TomlValue,
): McpServer | null => {
  const table = toTomlTable(value, `mcp_servers.${name}`);
  if (table === undefined) throw new Error(`Expected mcp_servers.${name}`);
  const extras = collectExtras(table);
  const command = toTomlString(table.command, `mcp_servers.${name}.command`);
  const args = toTomlStringArray(table.args, `mcp_servers.${name}.args`);
  const cwd = toTomlString(table.cwd, `mcp_servers.${name}.cwd`);
  const url = toTomlString(table.url, `mcp_servers.${name}.url`);
  const env = toTomlStringRecord(table.env, `mcp_servers.${name}.env`);
  const bearerTokenEnvVar = toTomlString(
    table.bearer_token_env_var,
    `mcp_servers.${name}.bearer_token_env_var`,
  );
  const httpHeaders = toTomlStringRecord(
    table.http_headers,
    `mcp_servers.${name}.http_headers`,
  );
  const envHttpHeaders = toTomlStringRecord(
    table.env_http_headers,
    `mcp_servers.${name}.env_http_headers`,
  );
  const startupTimeoutSec = toTomlNumber(
    table.startup_timeout_sec,
    `mcp_servers.${name}.startup_timeout_sec`,
  );
  if (url !== undefined)
    return {
      name,
      transport: "http",
      url,
      ...(bearerTokenEnvVar === undefined ? {} : { bearerTokenEnvVar }),
      ...(httpHeaders === undefined ? {} : { httpHeaders }),
      ...(envHttpHeaders === undefined ? {} : { envHttpHeaders }),
      ...(startupTimeoutSec === undefined ? {} : { startupTimeoutSec }),
      ...(extras === undefined ? {} : { extras }),
    };
  if (command === undefined) return null;
  return {
    name,
    transport: "stdio",
    command,
    ...(args === undefined ? {} : { args }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    ...(startupTimeoutSec === undefined ? {} : { startupTimeoutSec }),
    ...(extras === undefined ? {} : { extras }),
  };
};

export const parseMcpServers = (
  deps: AgentMcpDeps,
  cwd: string,
): McpServer[] => {
  const files = [
    `${deps.home}/.codex/config.toml`,
    `${cwd}/.codex/config.toml`,
  ];
  const servers = new Map<string, McpServer>();
  for (const file of files) {
    const text = deps.readFile(file);
    if (text === null) continue;
    let parsed: TomlTable;
    try {
      parsed = parse(text);
    } catch {
      continue;
    }
    const mcpServers = toTomlTable(parsed.mcp_servers, "mcp_servers");
    if (mcpServers === undefined) continue;
    for (const [name, value] of Object.entries(mcpServers)) {
      const server = toMcpServer(name, value);
      if (server !== null) servers.set(name, server);
    }
  }
  return [...servers.values()];
};

export const formatMcpConfig = (servers: McpServer[]): McpConfigWrite => {
  const mcpServers: Record<string, TomlTable> = {};
  for (const server of servers) {
    const table: TomlTable = {};
    for (const [key, value] of Object.entries(server.extras ?? {}))
      table[key] = value as TomlValue;
    if (server.startupTimeoutSec !== undefined)
      table.startup_timeout_sec = server.startupTimeoutSec;
    if (server.command !== undefined) table.command = server.command;
    if (server.args !== undefined) table.args = server.args;
    if (server.cwd !== undefined) table.cwd = server.cwd;
    if (server.url !== undefined) table.url = server.url;
    if (server.bearerTokenEnvVar !== undefined)
      table.bearer_token_env_var = server.bearerTokenEnvVar;
    if (server.httpHeaders !== undefined)
      table.http_headers = server.httpHeaders;
    if (server.envHttpHeaders !== undefined)
      table.env_http_headers = server.envHttpHeaders;
    if (server.env !== undefined) table.env = server.env;
    mcpServers[server.name] = table;
  }
  return {
    path: "$HOME/.codex/config.toml",
    content: `${stringify({ mcp_servers: mcpServers })}\n`,
    mode: "replace-mcp-section",
  };
};
