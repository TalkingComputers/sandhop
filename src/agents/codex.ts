import type {
  Agent,
  AgentHostDeps,
  AgentMcpDeps,
  AgentSessionDeps,
  AuthBundle,
  McpConfigWrite,
  McpServer,
} from "../core/ports/agent.js";
import { collectEnvRefs } from "../core/env.js";
import { buildCodexPreSeedScript } from "../core/sandbox-scripts.js";
import { basename } from "../core/paths.js";
import { shellQuote } from "../core/shell.js";
import { parse, stringify, type TomlTable, type TomlValue } from "smol-toml";
import { makeVersionParser, sortNewest } from "./shared.js";

interface CodexTranscriptName {
  sessionId: string;
  year: string;
  month: string;
  day: string;
}

const parseCodexTranscriptName = (file: string): CodexTranscriptName => {
  const match = file.match(
    /rollout-(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T\d{2}-\d{2}-\d{2}-(?<sessionId>.+)\.jsonl$/,
  );
  if (match === null || match.groups === undefined)
    throw new Error(`Invalid Codex transcript filename ${file}`);
  const { year, month, day, sessionId } = match.groups;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    sessionId === undefined
  )
    throw new Error(`Invalid Codex transcript filename ${file}`);
  return { sessionId, year, month, day };
};

const codexId = (file: string): string => {
  return parseCodexTranscriptName(file).sessionId;
};

const parseVersion = makeVersionParser("codex");

const readRecordedCwd = (
  deps: AgentSessionDeps,
  path: string,
): string | null => {
  const text = deps.readFile(path);
  if (text === null) return null;
  const first = text.split("\n", 1)[0]!;
  try {
    const parsed = JSON.parse(first) as { payload?: { cwd?: unknown } };
    return typeof parsed.payload?.cwd === "string" ? parsed.payload.cwd : null;
  } catch {
    return null;
  }
};

const isTomlTable = (value: unknown): value is TomlTable =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date);

const toTomlTable = (
  value: TomlValue | undefined,
  path: string,
): TomlTable | undefined => {
  if (value === undefined) return undefined;
  if (!isTomlTable(value)) throw new Error(`Expected ${path} to be a table`);
  return value;
};

const toTomlString = (
  value: TomlValue | undefined,
  path: string,
): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new Error(`Expected ${path} to be a string`);
  return value;
};

const toTomlStringArray = (
  value: TomlValue | undefined,
  path: string,
): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Expected ${path} to be an array`);
  return value.map((item, index) => {
    if (typeof item !== "string")
      throw new Error(`Expected ${path}[${index}] to be a string`);
    return item;
  });
};

const toTomlStringRecord = (
  value: TomlValue | undefined,
  path: string,
): Record<string, string> | undefined => {
  const table = toTomlTable(value, path);
  if (table === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(table).map(([key, field]) => {
      if (typeof field !== "string")
        throw new Error(`Expected ${path}.${key} to be a string`);
      return [key, field];
    }),
  );
};

const toTomlNumber = (
  value: TomlValue | undefined,
  path: string,
): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number")
    throw new Error(`Expected ${path} to be a number`);
  return value;
};

const collectEnvRefsFromValue = (refs: Set<string>, value: TomlValue): void => {
  if (typeof value === "string")
    for (const name of collectEnvRefs(value)) refs.add(name);
  else if (Array.isArray(value))
    for (const item of value) collectEnvRefsFromValue(refs, item);
  else if (isTomlTable(value))
    for (const item of Object.values(value))
      collectEnvRefsFromValue(refs, item);
};

const readTomlEnvRefs = (text: string): string[] => {
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

const toMcpServer = (name: string, value: TomlValue): McpServer => {
  const table = toTomlTable(value, `mcp_servers.${name}`);
  if (table === undefined) throw new Error(`Expected mcp_servers.${name}`);
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
  return {
    name,
    transport: url === undefined ? "stdio" : "http",
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(url === undefined ? {} : { url }),
    ...(env === undefined ? {} : { env }),
    ...(bearerTokenEnvVar === undefined ? {} : { bearerTokenEnvVar }),
    ...(httpHeaders === undefined ? {} : { httpHeaders }),
    ...(envHttpHeaders === undefined ? {} : { envHttpHeaders }),
    ...(startupTimeoutSec === undefined ? {} : { startupTimeoutSec }),
  };
};

const parseMcpServers = (deps: AgentMcpDeps, cwd: string): McpServer[] => {
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
    for (const [name, value] of Object.entries(mcpServers))
      servers.set(name, toMcpServer(name, value));
  }
  return [...servers.values()].filter(
    (server) => server.command !== undefined || server.url !== undefined,
  );
};

const formatMcpConfig = (servers: McpServer[]): McpConfigWrite => {
  const mcpServers: Record<string, TomlTable> = {};
  for (const server of servers) {
    const table: TomlTable = {};
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
    mode: "append",
  };
};

const authEnv = (deps: AgentHostDeps): AuthBundle => {
  const authJson = deps.readFile(`${deps.home}/.codex/auth.json`);
  const configToml = deps.readFile(`${deps.home}/.codex/config.toml`);
  const envs: Record<string, string> = {};
  const configFiles =
    configToml === null
      ? []
      : [{ path: "$HOME/.codex/config.toml", content: configToml }];
  const apiKey = deps.env.OPENAI_API_KEY;
  if (apiKey !== undefined) envs.OPENAI_API_KEY = apiKey;
  const codexApiKey = deps.env.CODEX_API_KEY;
  if (codexApiKey !== undefined) envs.CODEX_API_KEY = codexApiKey;
  if (authJson !== null && authJson.trim().length > 0)
    return {
      envs,
      files: [
        { path: "$HOME/.codex/auth.json", content: authJson, mode: "600" },
        ...configFiles,
      ],
    };
  const codexHome = `${deps.home}/.codex`;
  if (deps.exists(codexHome)) {
    const account = `cli|${deps.sha256Hex(deps.realpath(codexHome)).slice(0, 16)}`;
    const keychainJson = deps.keychain("Codex Auth", account);
    if (keychainJson !== null && keychainJson.trim().length > 0)
      return {
        envs,
        files: [
          {
            path: "$HOME/.codex/auth.json",
            content: keychainJson,
            mode: "600",
          },
          ...configFiles,
        ],
      };
  }
  if (Object.keys(envs).length > 0) return { envs, files: configFiles };
  throw new Error(
    "No Codex credential at ~/.codex/auth.json, OS keychain, OPENAI_API_KEY, or CODEX_API_KEY",
  );
};

export const CODEX: Agent = {
  id: "codex",
  pkg: "@openai/codex",
  bin: "codex",
  detectVersionArgs: ["--version"],
  parseVersion,
  matchSession: (deps, cwd) => {
    const root = `${deps.home}/.codex/sessions`;
    return sortNewest(
      deps,
      deps
        .walk(root)
        .filter((path) => /rollout-.*\.jsonl$/.test(path))
        .filter((path) => readRecordedCwd(deps, path) === cwd)
        .map((path) => {
          const name = basename(path);
          return {
            sessionId: codexId(name),
            transcriptPath: path,
            transcriptName: name,
          };
        }),
    );
  },
  profilePaths: () => [
    ".codex/AGENTS.md",
    ".codex/instructions.md",
    ".codex/prompts",
    ".codex/rules",
  ],
  mcpConfigPaths: (home, cwd) => [
    `${home}/.codex/config.toml`,
    `${cwd}/.codex/config.toml`,
  ],
  mcpEnvRefs: readTomlEnvRefs,
  parseMcpServers,
  formatMcpConfig,
  authEnv,
  installCmd: (version) => `npm i -g @openai/codex@${version}`,
  supportsSettingsScripts: () => false,
  supportsReinstall: () => false,
  preSeed: (remoteProj) => [
    "mkdir -p $HOME/.codex",
    `node -e ${shellQuote(buildCodexPreSeedScript(remoteProj))}`,
  ],
  remoteTranscriptPath: (home, remoteEnc, transcriptName) => {
    const { year, month, day } = parseCodexTranscriptName(transcriptName);
    return `${home}/.codex/sessions/${year}/${month}/${day}/${transcriptName}`;
  },
  resumeCmd: (sessionId, remoteProj) =>
    `cd ${shellQuote(remoteProj)} && codex resume ${shellQuote(sessionId)}`,
};
