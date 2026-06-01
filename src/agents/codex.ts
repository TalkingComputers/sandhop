import type {
  Agent,
  AgentHostDeps,
  AgentSessionDeps,
  AuthBundle,
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
  if (authJson !== null)
    return {
      envs,
      files: [{ path: "$HOME/.codex/auth.json", content: authJson }],
    };
  if (Object.keys(envs).length > 0) return { envs, files: [] };
  throw new Error(
    "No Codex credential at ~/.codex/auth.json and no OPENAI_API_KEY",
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
  authEnv,
  installCmd: (version) => `npm i -g @openai/codex@${version}`,
  preSeed: (remoteProj) => [
    "mkdir -p $HOME/.codex",
    `node -e ${JSON.stringify(buildCodexPreSeedScript(remoteProj))}`,
  ],
  remoteTranscriptPath: (remoteEnc, transcriptName) =>
    `$HOME/.codex/sessions/restored/${transcriptName}`,
  resumeCmd: (sessionId, remoteProj) =>
    `cd ${remoteProj} && codex resume ${sessionId}`,
};
