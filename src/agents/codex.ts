import type {
  Agent,
  AgentHostDeps,
  AgentMcpDeps,
  AgentSessionDeps,
  AuthBundle,
  McpConfigWrite,
  McpServer,
  SessionRef,
} from "../core/ports/agent.js";

const fileName = (path: string): string => path.split("/").pop()!;

const sortNewest = (deps: AgentSessionDeps, refs: SessionRef[]): SessionRef[] =>
  [...refs].sort(
    (a, b) =>
      deps.statMtimeMs(b.transcriptPath) - deps.statMtimeMs(a.transcriptPath),
  );

const codexId = (file: string): string => {
  const match = file.match(
    /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/,
  );
  if (!match) throw new Error(`Invalid Codex transcript filename ${file}`);
  return match[1]!;
};

const parseVersion = (output: string): string => {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  if (!match) throw new Error(`Could not parse codex version from "${output}"`);
  return match[1]!;
};

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

const readTomlEnvRefs = (text: string): string[] => {
  const refs = new Set<string>();
  for (const match of text.matchAll(
    /(?:\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)|process\.env\.([A-Z][A-Z0-9_]*))/g,
  )) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name !== undefined) refs.add(name);
  }
  let inEnv = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[.*\.env\]$/.test(trimmed)) {
      inEnv = true;
      continue;
    }
    if (trimmed.startsWith("[")) inEnv = false;
    if (inEnv) {
      const key = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=/)?.[1];
      if (key !== undefined) refs.add(key);
    }
    const inlineEnv = trimmed.match(/env\s*=\s*\{([^}]*)\}/)?.[1];
    if (inlineEnv !== undefined) {
      for (const match of inlineEnv.matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*=/g))
        refs.add(match[1]!);
    }
  }
  return [...refs].sort();
};

const trimQuotes = (value: string): string =>
  value.replace(/^"|"$/g, "").replace(/\\"/g, '"');

const readTomlString = (value: string): string | undefined => {
  const trimmed = value.trim();
  return /^"(?:\\.|[^"])*"$/.test(trimmed) ? trimQuotes(trimmed) : undefined;
};

const readTomlArray = (value: string): string[] | undefined => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const values: string[] = [];
  for (const match of trimmed.matchAll(/"((?:\\.|[^"])*)"/g)) {
    values.push(match[1]!.replace(/\\"/g, '"'));
  }
  return values;
};

const readTomlInlineEnv = (
  value: string,
): Record<string, string> | undefined => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const env: Record<string, string> = {};
  for (const match of trimmed.matchAll(
    /([A-Za-z][A-Za-z0-9_]*)\s*=\s*"((?:\\.|[^"])*)"/g,
  )) {
    env[match[1]!] = match[2]!.replace(/\\"/g, '"');
  }
  return env;
};

const parseMcpServers = (deps: AgentMcpDeps, cwd: string): McpServer[] => {
  const files = [
    `${deps.home}/.codex/config.toml`,
    `${cwd}/.codex/config.toml`,
  ];
  const servers: Record<string, McpServer> = {};
  let currentName: string | null = null;
  let inEnv = false;
  for (const file of files) {
    const text = deps.readFile(file);
    if (text === null) continue;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const envHeader = trimmed.match(/^\[mcp_servers\.("?[^".\]]+"?)\.env\]$/);
      if (envHeader) {
        currentName = trimQuotes(envHeader[1]!);
        inEnv = true;
        servers[currentName] = servers[currentName] ?? {
          name: currentName,
          transport: "stdio",
        };
        continue;
      }
      const serverHeader = trimmed.match(/^\[mcp_servers\.("?[^".\]]+"?)\]$/);
      if (serverHeader) {
        currentName = trimQuotes(serverHeader[1]!);
        inEnv = false;
        servers[currentName] = servers[currentName] ?? {
          name: currentName,
          transport: "stdio",
        };
        continue;
      }
      if (trimmed.startsWith("[")) {
        currentName = null;
        inEnv = false;
        continue;
      }
      if (currentName === null) continue;
      const pair = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.+)$/);
      if (!pair) continue;
      const key = pair[1]!;
      const raw = pair[2]!;
      const server = servers[currentName]!;
      if (inEnv) {
        const value = readTomlString(raw);
        if (value !== undefined)
          server.env = { ...(server.env ?? {}), [key]: value };
        continue;
      }
      if (key === "command") {
        const value = readTomlString(raw);
        if (value !== undefined) server.command = value;
      }
      if (key === "args") {
        const value = readTomlArray(raw);
        if (value !== undefined) server.args = value;
      }
      if (key === "cwd") {
        const value = readTomlString(raw);
        if (value !== undefined) server.cwd = value;
      }
      if (key === "url") {
        const value = readTomlString(raw);
        if (value !== undefined) {
          server.url = value;
          server.transport = "http";
        }
      }
      if (key === "env") {
        const value = readTomlInlineEnv(raw);
        if (value !== undefined) server.env = value;
      }
    }
  }
  return Object.values(servers).filter(
    (server) => server.command !== undefined || server.url !== undefined,
  );
};

const quoteToml = (value: string): string => JSON.stringify(value);

const formatMcpConfig = (servers: McpServer[]): McpConfigWrite => {
  const lines: string[] = [];
  for (const server of servers) {
    lines.push(`[mcp_servers.${quoteToml(server.name)}]`);
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
