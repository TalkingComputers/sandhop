import { projectDirName } from "../core/encode.js";
import { collectEnvRefs } from "../core/env.js";
import { isRecord, parseJsonRecord } from "../core/json.js";
import { basename } from "../core/paths.js";
import { quote } from "shell-quote";
import {
  buildClaudePreSeedScript,
  renderNodeScript,
} from "../core/sandbox-scripts.js";
import type {
  Agent,
  AgentHostDeps,
  AgentMcpDeps,
  AuthBundle,
  McpConfigWrite,
  McpServer,
  McpTransport,
  RemoteMcpServer,
} from "../core/ports/agent.js";
import { makeVersionParser, sortNewest } from "./shared.js";
import {
  CLAUDE_JSON_HOME_PATH,
  CLAUDE_JSON_PATH,
  CLAUDE_MCP_PATH,
  CLAUDE_PROJECTS_PATH,
  CLAUDE_SETTINGS_LOCAL_PATH,
  CLAUDE_SETTINGS_PATH,
  joinClaudeLocalPath,
} from "./claude-paths.js";

const CLAUDE_CREDENTIALS_PATH = ".claude/.credentials.json";
const GOOGLE_CREDENTIALS_REMOTE_PATH = "$HOME/.sandhop/google-creds.json";

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

const hasText = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.length > 0;

const addEnv = (
  envs: Record<string, string>,
  deps: AgentHostDeps,
  name: string,
): void => {
  const value = deps.env[name];
  if (value !== undefined) envs[name] = value;
};

const addEnvs = (
  envs: Record<string, string>,
  deps: AgentHostDeps,
  names: string[],
): void => {
  for (const name of names) addEnv(envs, deps, name);
};

const authEnv = (deps: AgentHostDeps): AuthBundle => {
  const envs: Record<string, string> = {};
  const files: AuthBundle["files"] = [];
  const credentialsFile = deps.readFile(
    joinClaudeLocalPath(deps.home, CLAUDE_CREDENTIALS_PATH),
  );
  const credentials =
    credentialsFile === null
      ? deps.keychain("Claude Code-credentials", null)
      : credentialsFile;
  if (hasText(credentials))
    files.push({
      path: "$HOME/.claude/.credentials.json",
      content: credentials,
      mode: "600",
    });
  const envKey = deps.env.ANTHROPIC_API_KEY;
  const apiKey = hasText(envKey) ? envKey : deps.keychain("Claude Code", null);
  if (hasText(apiKey)) envs.ANTHROPIC_API_KEY = apiKey;
  addEnv(envs, deps, "CLAUDE_CODE_OAUTH_TOKEN");
  if (deps.env.ANTHROPIC_AUTH_TOKEN !== undefined)
    addEnvs(envs, deps, [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_CUSTOM_HEADERS",
    ]);
  if (deps.env.CLAUDE_CODE_USE_BEDROCK !== undefined)
    addEnvs(envs, deps, [
      "CLAUDE_CODE_USE_BEDROCK",
      "AWS_REGION",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "ANTHROPIC_BEDROCK_BASE_URL",
    ]);
  if (deps.env.CLAUDE_CODE_USE_VERTEX !== undefined) {
    addEnvs(envs, deps, [
      "CLAUDE_CODE_USE_VERTEX",
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "CLOUD_ML_REGION",
      "ANTHROPIC_VERTEX_BASE_URL",
    ]);
    const googleCredentialsPath = deps.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (googleCredentialsPath !== undefined) {
      const googleCredentials = deps.readFile(googleCredentialsPath);
      if (googleCredentials !== null) {
        files.push({
          path: GOOGLE_CREDENTIALS_REMOTE_PATH,
          content: googleCredentials,
          mode: "600",
        });
        envs.GOOGLE_APPLICATION_CREDENTIALS = GOOGLE_CREDENTIALS_REMOTE_PATH;
      }
    }
  }
  if (
    files.some((file) => file.path === "$HOME/.claude/.credentials.json") ||
    envs.ANTHROPIC_API_KEY !== undefined ||
    envs.CLAUDE_CODE_OAUTH_TOKEN !== undefined ||
    envs.ANTHROPIC_AUTH_TOKEN !== undefined ||
    envs.CLAUDE_CODE_USE_BEDROCK !== undefined ||
    envs.CLAUDE_CODE_USE_VERTEX !== undefined
  )
    return { envs, files };
  throw new Error(
    "No Claude Code credential found. Provide one of: ~/.claude/.credentials.json, keychain service Claude Code-credentials, ANTHROPIC_API_KEY, keychain service Claude Code, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX",
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

const readClaudeRemoteTransport = (
  type: unknown,
): RemoteMcpServer["transport"] => {
  if (type === "sse" || type === "http" || type === "ws") return type;
  if (type === "streamable-http") return "http";
  return "http";
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
    const headers = readStringRecord(server.headers);
    const cwd = typeof server.cwd === "string" ? server.cwd : undefined;
    if (url !== undefined) {
      servers.push({
        name,
        transport: readClaudeRemoteTransport(server.type),
        url,
        ...(headers === undefined ? {} : { headers }),
      });
      continue;
    }
    if (command === undefined) continue;
    servers.push({
      name,
      transport: "stdio",
      command,
      ...(args === undefined ? {} : { args }),
      ...(env === undefined ? {} : { env }),
      ...(cwd === undefined ? {} : { cwd }),
    });
  }
};

const parseMcpServers = (deps: AgentMcpDeps, cwd: string): McpServer[] => {
  const servers: McpServer[] = [];
  const claudeJson = deps.readFile(
    joinClaudeLocalPath(deps.home, CLAUDE_JSON_PATH),
  );
  if (claudeJson !== null) {
    const parsed = parseJsonRecord(claudeJson);
    if (parsed !== null) {
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
    const parsed = parseJsonRecord(mcpJson);
    if (parsed !== null) readMcpServers(parsed.mcpServers, servers);
  }
  return servers;
};

const formatMcpConfig = (servers: McpServer[]): McpConfigWrite => {
  const mcpServers: Record<
    string,
    Omit<McpServer, "name" | "transport"> & { type: McpTransport }
  > = {};
  for (const server of servers) {
    const { name, transport, ...config } = server;
    mcpServers[name] = { type: transport, ...config };
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
          const name = basename(path);
          return {
            sessionId: name.replace(/\.jsonl$/, ""),
            transcriptPath: path,
            transcriptName: name,
          };
        }),
    );
  },
  mcpConfigPaths: (home, cwd) => [
    `${cwd}/.mcp.json`,
    `${cwd}/${CLAUDE_SETTINGS_PATH}`,
    `${cwd}/${CLAUDE_SETTINGS_LOCAL_PATH}`,
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
  preSeed: (remoteProj) =>
    renderNodeScript(buildClaudePreSeedScript(remoteProj), "CLAUDE_PRESEED"),
  remoteTranscriptPath: (home, remoteEnc, transcriptName) =>
    `${home}/${CLAUDE_PROJECTS_PATH}/${remoteEnc}/${transcriptName}`,
  projectMemoryDir: (home, remoteEnc) =>
    `${home}/${CLAUDE_PROJECTS_PATH}/${remoteEnc}/memory`,
  resumeCmd: (sessionId, remoteProj, mcpTimeout) => {
    const env =
      mcpTimeout === undefined ? "" : `MCP_TIMEOUT=${quote([mcpTimeout])} `;
    return `cd ${quote([remoteProj])} && ${env}claude --resume ${quote([sessionId])}`;
  },
};
