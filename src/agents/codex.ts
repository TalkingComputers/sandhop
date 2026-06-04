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
import { MCP_STARTUP_TIMEOUT_SEC } from "../core/mcp-timeout.js";
import { parse, type TomlTable, type TomlValue } from "smol-toml";
import { fileName, makeVersionParser, sortNewest } from "./shared.js";

const codexId = (file: string): string => {
  const match = file.match(
    /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/,
  );
  if (!match) throw new Error(`Invalid Codex transcript filename ${file}`);
  return match[1]!;
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
  const parsed = parse(text);
  const mcpServers = toTomlTable(parsed.mcp_servers, "mcp_servers");
  if (mcpServers !== undefined)
    for (const [name, value] of Object.entries(mcpServers)) {
      const server = toTomlTable(value, `mcp_servers.${name}`);
      if (server === undefined) throw new Error(`Expected mcp_servers.${name}`);
      const env = toTomlTable(server.env, `mcp_servers.${name}.env`);
      if (env !== undefined) for (const key of Object.keys(env)) refs.add(key);
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
  return {
    name,
    transport: url === undefined ? "stdio" : "http",
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(url === undefined ? {} : { url }),
    ...(env === undefined ? {} : { env }),
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
    const parsed = parse(text);
    const mcpServers = toTomlTable(parsed.mcp_servers, "mcp_servers");
    if (mcpServers === undefined) continue;
    for (const [name, value] of Object.entries(mcpServers))
      servers.set(name, toMcpServer(name, value));
  }
  return [...servers.values()].filter(
    (server) => server.command !== undefined || server.url !== undefined,
  );
};

const quoteToml = (value: string): string => JSON.stringify(value);

const formatMcpConfig = (servers: McpServer[]): McpConfigWrite => {
  const lines: string[] = [];
  for (const server of servers) {
    lines.push(`[mcp_servers.${quoteToml(server.name)}]`);
    lines.push(`startup_timeout_sec = ${MCP_STARTUP_TIMEOUT_SEC}`);
    if (server.command !== undefined)
      lines.push(`command = ${quoteToml(server.command)}`);
    if (server.args !== undefined)
      lines.push(`args = [${server.args.map(quoteToml).join(", ")}]`);
    if (server.cwd !== undefined) lines.push(`cwd = ${quoteToml(server.cwd)}`);
    if (server.url !== undefined) lines.push(`url = ${quoteToml(server.url)}`);
    if (server.env !== undefined) {
      lines.push("", `[mcp_servers.${quoteToml(server.name)}.env]`);
      for (const [key, value] of Object.entries(server.env))
        lines.push(`${key} = ${quoteToml(value)}`);
    }
    lines.push("");
  }
  return {
    path: "$HOME/.codex/config.toml",
    content: lines.join("\n"),
    mode: "append",
  };
};

const buildCodexPreSeedScript = (remoteProj: string): string =>
  [
    'const fs=require("fs")',
    'const f=process.env.HOME+"/.codex/config.toml"',
    `const project=${JSON.stringify(remoteProj)}`,
    'const projectHeader="[projects."+JSON.stringify(project)+"]"',
    'const root=["approval_policy = \\"never\\"","sandbox_mode = \\"danger-full-access\\"","cli_auth_credentials_store = \\"file\\""]',
    "const rootKey=/^(approval_policy|sandbox_mode|cli_auth_credentials_store)\\s*=/",
    'let lines=fs.existsSync(f)?fs.readFileSync(f,"utf8").split(/\\r?\\n/):[]',
    'if(lines.length===1&&lines[0]==="")lines=[]',
    "let table=false",
    "const kept=[]",
    "for(const line of lines){if(/^\\s*\\[/.test(line))table=true;if(!table&&rootKey.test(line.trim()))continue;kept.push(line)}",
    "const withoutProject=[]",
    "for(let i=0;i<kept.length;i++){if(kept[i].trim()===projectHeader){i++;while(i<kept.length&&!/^\\s*\\[/.test(kept[i]))i++;i--}else withoutProject.push(kept[i])}",
    'while(withoutProject[withoutProject.length-1]==="")withoutProject.pop()',
    "const firstTable=withoutProject.findIndex(line=>/^\\s*\\[/.test(line))",
    "const beforeRoot=firstTable===-1?withoutProject:withoutProject.slice(0,firstTable)",
    "const afterRoot=firstTable===-1?[]:withoutProject.slice(firstTable)",
    "const out=[...beforeRoot]",
    'if(out.length>0&&out[out.length-1]!=="")out.push("")',
    "out.push(...root)",
    'if(afterRoot.length>0)out.push("",...afterRoot)',
    'out.push("",projectHeader,"trust_level = \\\"trusted\\\"")',
    'fs.mkdirSync(process.env.HOME+"/.codex",{recursive:true})',
    'fs.writeFileSync(f,out.join("\\n")+"\\n")',
  ].join(";");

const authEnv = (deps: AgentHostDeps): AuthBundle => {
  const authJson = deps.readFile(`${deps.home}/.codex/auth.json`);
  const envs: Record<string, string> = {};
  const apiKey = deps.env.OPENAI_API_KEY;
  if (apiKey !== undefined) envs.OPENAI_API_KEY = apiKey;
  const codexApiKey = deps.env.CODEX_API_KEY;
  if (codexApiKey !== undefined) envs.CODEX_API_KEY = codexApiKey;
  if (authJson !== null && authJson.trim().length > 0)
    return {
      envs,
      files: [{ path: "$HOME/.codex/auth.json", content: authJson }],
    };
  const codexHome = `${deps.home}/.codex`;
  if (deps.exists(codexHome)) {
    const account = `cli|${deps.sha256Hex(deps.realpath(codexHome)).slice(0, 16)}`;
    const keychainJson = deps.keychain("Codex Auth", account);
    if (keychainJson !== null && keychainJson.trim().length > 0)
      return {
        envs,
        files: [{ path: "$HOME/.codex/auth.json", content: keychainJson }],
      };
  }
  if (Object.keys(envs).length > 0) return { envs, files: [] };
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
  sessionsRoot: (home) => `${home}/.codex/sessions`,
  matchSession: (deps, cwd) => {
    const root = `${deps.home}/.codex/sessions`;
    return sortNewest(
      deps,
      deps
        .walk(root)
        .filter((path) => /rollout-.*\.jsonl$/.test(path))
        .filter((path) => readRecordedCwd(deps, path) === cwd)
        .map((path) => {
          const name = fileName(path);
          return {
            sessionId: codexId(name),
            transcriptPath: path,
            transcriptName: name,
          };
        }),
    );
  },
  profilePaths: () => [
    ".codex/config.toml",
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
    `node -e ${JSON.stringify(buildCodexPreSeedScript(remoteProj))}`,
  ],
  remoteTranscriptPath: (remoteEnc, transcriptName) =>
    `$HOME/.codex/sessions/restored/${transcriptName}`,
  resumeCmd: (sessionId, remoteProj) =>
    `cd "${remoteProj}" && codex resume ${sessionId}`,
};
