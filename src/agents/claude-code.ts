import { projectDirName } from "../core/encode.js";
import { collectEnvRefs } from "../core/env.js";
import { isRecord } from "../core/json.js";
import { MCP_TIMEOUT_MS } from "../core/mcp-timeout.js";
import { buildClaudePreSeedScript } from "../core/sandbox-scripts.js";
import type {
  Agent,
  AgentHostDeps,
  AgentMcpDeps,
  AuthBundle,
  McpConfigWrite,
  McpServer,
  McpTransport,
} from "../core/ports/agent.js";
import { fileName, makeVersionParser, sortNewest } from "./shared.js";
import {
  CLAUDE_JSON_HOME_PATH,
  CLAUDE_JSON_PATH,
  CLAUDE_MCP_PATH,
  CLAUDE_PROFILE_PATHS,
  CLAUDE_PROJECTS_PATH,
  CLAUDE_SETTINGS_LOCAL_PATH,
  CLAUDE_SETTINGS_PATH,
  joinClaudeHomePath,
  joinClaudeLocalPath,
} from "./claude-paths.js";

const addJsonEnvRefs = (refs: Set<string>, value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) addJsonEnvRefs(refs, item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "env" && isRecord(child)) {
      for (const name of Object.keys(child)) refs.add(name);
    }
    addJsonEnvRefs(refs, child);
  }
};

const readJsonEnvRefs = (text: string): string[] => {
  const refs = new Set<string>();
  for (const name of collectEnvRefs(text)) refs.add(name);
  try {
    addJsonEnvRefs(refs, JSON.parse(text) as unknown);
  } catch {
    return [...refs].sort();
  }
  return [...refs].sort();
};

const parseVersion = makeVersionParser("claude-code");

const authEnv = (deps: AgentHostDeps): AuthBundle => {
  const envKey = deps.env.ANTHROPIC_API_KEY;
  if (envKey !== undefined && envKey.startsWith("sk-ant-"))
    return { envs: { ANTHROPIC_API_KEY: envKey }, files: [] };
  const keychainKey = deps.keychain("Claude Code", null);
  if (keychainKey !== null && keychainKey.startsWith("sk-ant-"))
    return { envs: { ANTHROPIC_API_KEY: keychainKey }, files: [] };
  const oauth = deps.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth !== undefined)
    return { envs: { CLAUDE_CODE_OAUTH_TOKEN: oauth }, files: [] };
  throw new Error(
    "No Claude Code credential. Run: claude setup-token, then export CLAUDE_CODE_OAUTH_TOKEN",
  );
};

const readStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    values.push(item);
  }
  return values;
};

const readStringRecord = (
  value: unknown,
): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return undefined;
    record[key] = item;
  }
  return record;
};

const readTransport = (value: unknown, hasUrl: boolean): McpTransport => {
  if (value === "sse") return "sse";
  if (value === "http" || hasUrl) return "http";
  return "stdio";
};

const readMcpServers = (value: unknown, servers: McpServer[]): void => {
  if (!isRecord(value)) return;
  for (const [name, server] of Object.entries(value)) {
    if (!isRecord(server)) continue;
    const command =
      typeof server.command === "string" ? server.command : undefined;
    const url = typeof server.url === "string" ? server.url : undefined;
    if (command === undefined && url === undefined) continue;
    const args = readStringArray(server.args);
    const env = readStringRecord(server.env);
    const cwd = typeof server.cwd === "string" ? server.cwd : undefined;
    servers.push({
      name,
      transport: readTransport(server.transport, url !== undefined),
      ...(command === undefined ? {} : { command }),
      ...(args === undefined ? {} : { args }),
      ...(env === undefined ? {} : { env }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(url === undefined ? {} : { url }),
    });
  }
};

const parseMcpServers = (deps: AgentMcpDeps, cwd: string): McpServer[] => {
  const servers: McpServer[] = [];
  const claudeJson = deps.readFile(
    joinClaudeLocalPath(deps.home, CLAUDE_JSON_PATH),
  );
  if (claudeJson !== null) {
    const parsed = JSON.parse(claudeJson) as unknown;
    if (isRecord(parsed)) {
      readMcpServers(parsed.mcpServers, servers);
      const projects = parsed.projects;
      if (isRecord(projects)) {
        const project = projects[cwd];
        if (isRecord(project)) readMcpServers(project.mcpServers, servers);
      }
    }
  }
  const mcpJson = deps.readFile(`${cwd}/.mcp.json`);
  if (mcpJson !== null) {
    const parsed = JSON.parse(mcpJson) as unknown;
    if (isRecord(parsed)) readMcpServers(parsed.mcpServers, servers);
  }
  return servers;
};

const formatMcpConfig = (servers: McpServer[]): McpConfigWrite => {
  const mcpServers: Record<string, Omit<McpServer, "name">> = {};
  for (const server of servers) {
    const { name, ...config } = server;
    mcpServers[name] = config;
  }
  return {
    path: CLAUDE_JSON_HOME_PATH,
    content: `${JSON.stringify(mcpServers, null, 2)}\n`,
    mode: "merge-claude-json",
  };
};

export const CLAUDE_CODE: Agent = {
  id: "claude-code",
  pkg: "@anthropic-ai/claude-code",
  bin: "claude",
  detectVersionArgs: ["--version"],
  parseVersion,
  sessionsRoot: (home) => joinClaudeLocalPath(home, CLAUDE_PROJECTS_PATH),
  matchSession: (deps, cwd) => {
    const root = `${joinClaudeLocalPath(
      deps.home,
      CLAUDE_PROJECTS_PATH,
    )}/${projectDirName(cwd)}`;
    return sortNewest(
      deps,
      deps
        .walk(root)
        .filter((path) => path.endsWith(".jsonl"))
        .map((path) => {
          const name = fileName(path);
          return {
            sessionId: name.replace(/\.jsonl$/, ""),
            transcriptPath: path,
            transcriptName: name,
          };
        }),
    );
  },
  profilePaths: () => [...CLAUDE_PROFILE_PATHS],
  mcpConfigPaths: (home, cwd) => [
    `${cwd}/.mcp.json`,
    joinClaudeLocalPath(home, CLAUDE_SETTINGS_PATH),
    joinClaudeLocalPath(home, CLAUDE_SETTINGS_LOCAL_PATH),
    joinClaudeLocalPath(home, CLAUDE_MCP_PATH),
    joinClaudeLocalPath(home, CLAUDE_JSON_PATH),
  ],
  mcpEnvRefs: readJsonEnvRefs,
  parseMcpServers,
  formatMcpConfig,
  authEnv,
  installCmd: (version) => `npm i -g @anthropic-ai/claude-code@${version}`,
  supportsSettingsScripts: () => true,
  supportsReinstall: () => true,
  preSeed: (remoteProj) => [
    `node -e ${JSON.stringify(buildClaudePreSeedScript(remoteProj))}`,
  ],
  remoteTranscriptPath: (remoteEnc, transcriptName) =>
    `${joinClaudeHomePath(
      CLAUDE_PROJECTS_PATH,
    )}/${remoteEnc}/${transcriptName}`,
  resumeCmd: (sessionId, remoteProj) =>
    `cd "${remoteProj}" && MCP_TIMEOUT=${MCP_TIMEOUT_MS} claude --resume ${sessionId}`,
};
