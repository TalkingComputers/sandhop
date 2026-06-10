import { projectDirName } from "../core/encode.js";
import { isRecord, parseJsonRecord } from "../core/json.js";
import { basename } from "../core/paths.js";
import { quote } from "shell-quote";
import {
  buildNodeScript,
  buildClaudePreSeedScript,
} from "../core/sandbox-scripts.js";
import type {
  Agent,
  AgentHostDeps,
  AgentMcpDeps,
  AgentSessionDeps,
  AgentPreSeedDeps,
  AuthBundle,
  McpConfigWrite,
  McpServer,
  McpTransport,
  RemoteMcpServer,
} from "../core/ports/agent.js";
import { makeVersionParser, sortNewest } from "./shared.js";
import {
  collectClaudeExtraEnvRefs,
  listClaudeProfileEntries,
  listExternalSymlinkSkills,
  readJsonEnvRefs,
} from "./claude-profile.js";
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

const parseVersion = makeVersionParser("claude-code");
const CLAUDE_PATH_EXPORT = 'export PATH="$HOME/.local/bin:$PATH"';
const CLAUDE_RUNTIME_ENV = "DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1";
const CLAUDE_SANDHOP_COMMAND = "<command-name>/sandhop</command-name>";

const isSandhopUserLine = (line: string): boolean => {
  if (!line.includes(CLAUDE_SANDHOP_COMMAND)) return false;
  const parsed = parseJsonRecord(line);
  return parsed !== null && parsed.type === "user";
};

const prepareTranscript = (
  deps: AgentSessionDeps,
  bytes: Uint8Array,
): Uint8Array => {
  void deps;
  const text = new TextDecoder().decode(bytes);
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isSandhopUserLine(lines[i]!)) continue;
    const head = lines.slice(0, i).join("\n");
    return new TextEncoder().encode(head.length === 0 ? "" : `${head}\n`);
  }
  return bytes;
};

const hasText = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.length > 0;

const CARRIED_PROJECT_KEYS = [
  "allowedTools",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "hasClaudeMdExternalIncludesApproved",
] as const;

const carriedProjectState = (
  deps: AgentPreSeedDeps,
  cwd: string,
): Record<string, unknown> => {
  const text = deps.readFile(joinClaudeLocalPath(deps.home, CLAUDE_JSON_PATH));
  const parsed = text === null ? null : parseJsonRecord(text);
  const projects = parsed?.projects;
  if (!isRecord(projects)) return {};
  const project = projects[cwd];
  if (!isRecord(project)) return {};
  const carried: Record<string, unknown> = {};
  for (const key of CARRIED_PROJECT_KEYS)
    if (project[key] !== undefined) carried[key] = project[key];
  return carried;
};

const installNativeClaude = (version: string): string =>
  [
    `expected=${quote([version])}`,
    'current="$("$HOME/.local/bin/claude" --version 2>/dev/null || true)"',
    'current="${current%% *}"',
    `if [ "$current" != "$expected" ]; then curl -fsSL https://claude.ai/install.sh | bash -s ${quote([version])}; fi`,
    CLAUDE_PATH_EXPORT,
    'actual="$("$HOME/.local/bin/claude" --version)"',
    'actual="${actual%% *}"',
    'test "$actual" = "$expected" || { printf \'Claude Code version mismatch: expected %s, got %s\\n\' "$expected" "$actual" >&2; exit 1; }',
  ].join(" && ");

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

const CONSUMED_SERVER_KEYS = new Set([
  "args",
  "command",
  "cwd",
  "env",
  "headers",
  "type",
  "url",
]);

const collectExtras = (
  server: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const entries = Object.entries(server).filter(
    ([key]) => !CONSUMED_SERVER_KEYS.has(key),
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
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
    const extras = collectExtras(server);
    if (url !== undefined) {
      servers.push({
        name,
        transport: readClaudeRemoteTransport(server.type),
        url,
        ...(headers === undefined ? {} : { headers }),
        ...(extras === undefined ? {} : { extras }),
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
      ...(extras === undefined ? {} : { extras }),
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
    Omit<McpServer, "name" | "transport" | "extras"> & { type: McpTransport }
  > = {};
  for (const server of servers) {
    const { name, transport, extras, ...config } = server;
    mcpServers[name] = { ...extras, type: transport, ...config };
  }
  return {
    path: CLAUDE_JSON_HOME_PATH,
    content: `${JSON.stringify(mcpServers, null, 2)}\n`,
    mode: "merge-mcp-servers",
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
  profileEntries: listClaudeProfileEntries,
  externalSkills: listExternalSymlinkSkills,
  extraEnvRefs: collectClaudeExtraEnvRefs,
  prepareTranscript,
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
  installCmd: installNativeClaude,
  supportsSettingsScripts: () => true,
  supportsReinstall: () => true,
  preSeed: (deps, remoteProj) => [
    buildNodeScript(
      buildClaudePreSeedScript(
        remoteProj,
        carriedProjectState(deps, remoteProj),
      ),
      "CLAUDE_PRESEED",
    ),
  ],
  remoteTranscriptPath: (home, remoteEnc, transcriptName) =>
    `${home}/${CLAUDE_PROJECTS_PATH}/${remoteEnc}/${transcriptName}`,
  projectMemoryPath: (remoteEnc) =>
    `${CLAUDE_PROJECTS_PATH}/${remoteEnc}/memory`,
  resumeCmd: (sessionId, remoteProj, mcpTimeout) => {
    const env =
      mcpTimeout === undefined ? "" : `MCP_TIMEOUT=${quote([mcpTimeout])} `;
    return `cd ${quote([remoteProj])} && ${CLAUDE_PATH_EXPORT} && ${CLAUDE_RUNTIME_ENV} ${env}claude --resume ${quote([sessionId])}`;
  },
};
