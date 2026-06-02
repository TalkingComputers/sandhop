import { projectDirName } from "../core/encode.js";
import type {
  Agent,
  AgentHostDeps,
  AgentMcpDeps,
  AgentSessionDeps,
  AuthBundle,
  McpConfigWrite,
  McpServer,
  McpTransport,
  SessionRef,
} from "../core/ports/agent.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fileName = (path: string): string => path.split("/").pop()!;

const sortNewest = (deps: AgentSessionDeps, refs: SessionRef[]): SessionRef[] =>
  [...refs].sort(
    (a, b) =>
      deps.statMtimeMs(b.transcriptPath) - deps.statMtimeMs(a.transcriptPath),
  );

const addPlaceholderRefs = (refs: Set<string>, text: string): void => {
  for (const match of text.matchAll(
    /(?:\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)|process\.env\.([A-Z][A-Z0-9_]*))/g,
  )) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name !== undefined) refs.add(name);
  }
};

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
  addPlaceholderRefs(refs, text);
  try {
    addJsonEnvRefs(refs, JSON.parse(text) as unknown);
  } catch {
    return [...refs].sort();
  }
  return [...refs].sort();
};

const parseVersion = (output: string): string => {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  if (!match)
    throw new Error(`Could not parse claude-code version from "${output}"`);
  return match[1]!;
};

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
  const claudeJson = deps.readFile(`${deps.home}/.claude.json`);
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

const formatMcpConfig = (
  servers: McpServer[],
  remoteProj: string,
): McpConfigWrite => {
  const mcpServers: Record<string, Omit<McpServer, "name">> = {};
  for (const server of servers) {
    const { name, ...config } = server;
    mcpServers[name] = config;
  }
  return {
    path: "$HOME/.claude.json",
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
  sessionsRoot: (home) => `${home}/.claude/projects`,
  matchSession: (deps, cwd) => {
    const root = `${deps.home}/.claude/projects/${projectDirName(cwd)}`;
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
  profilePaths: () => [
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/CLAUDE.md",
    ".claude/commands",
    ".claude/skills",
    ".claude/agents",
    ".claude/output-styles",
    ".claude/mcp.json",
    ".claude/plugins",
  ],
  mcpConfigPaths: (home, cwd) => [
    `${cwd}/.mcp.json`,
    `${home}/.claude/settings.json`,
    `${home}/.claude/settings.local.json`,
    `${home}/.claude/mcp.json`,
    `${home}/.claude.json`,
  ],
  mcpEnvRefs: readJsonEnvRefs,
  parseMcpServers,
  formatMcpConfig,
  authEnv,
  installCmd: (version) => `npm i -g @anthropic-ai/claude-code@${version}`,
  preSeed: (remoteProj) => {
    const script = `const fs=require("fs");const f=process.env.HOME+"/.claude.json";const j=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};j.hasCompletedOnboarding=true;if(!Object.hasOwn(j,"projects"))j.projects={};j.projects[${JSON.stringify(remoteProj)}]={hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true};if(process.env.ANTHROPIC_API_KEY){if(!Object.hasOwn(j,"customApiKeyResponses"))j.customApiKeyResponses={};j.customApiKeyResponses.approved=[process.env.ANTHROPIC_API_KEY.slice(-20)];j.customApiKeyResponses.rejected=[];}fs.writeFileSync(f,JSON.stringify(j))`;
    return [`node -e ${JSON.stringify(script)}`];
  },
  remoteTranscriptPath: (remoteEnc, transcriptName) =>
    `$HOME/.claude/projects/${remoteEnc}/${transcriptName}`,
  resumeCmd: (sessionId, remoteProj) =>
    `cd "${remoteProj}" && claude --resume ${sessionId}`,
};
