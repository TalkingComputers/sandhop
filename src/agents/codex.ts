import type {
  Agent,
  AgentHostDeps,
  AgentPreSeedDeps,
  AuthBundle,
} from "../core/ports/agent.js";
import {
  buildHomeWriteScript,
  buildNodeScript,
} from "../core/sandbox-scripts.js";
import { basename, uniqueSorted } from "../core/paths.js";
import { parse, stringify, type TomlTable } from "smol-toml";
import { quote } from "shell-quote";
import { isTomlTable } from "./codex-toml.js";
import { makeVersionParser, sortNewest } from "./shared.js";
import {
  collectSkillDirEnvRefs,
  listPlainSkillDirs,
  listSymlinkSkills,
} from "./skills.js";
import {
  formatMcpConfig,
  parseMcpServers,
  readTomlEnvRefs,
} from "./codex-mcp.js";
import {
  codexId,
  hasConversation,
  mergeForkAncestry,
  parseCodexTranscriptName,
  readModelProvider,
  readRecordedCwd,
} from "./codex-session.js";

const parseVersion = makeVersionParser("codex");
const CODEX_SKILLS_PATHS = [".agents/skills", ".codex/skills"];
const CODEX_CONFIG_PATH = ".codex/config.toml";

const buildPreSeededConfig = (
  deps: AgentPreSeedDeps,
  remoteProj: string,
): string => {
  const text = deps.readFile(`${deps.home}/${CODEX_CONFIG_PATH}`);
  const parsed: TomlTable = text === null ? {} : parse(text);
  parsed.cli_auth_credentials_store = "file";
  const projects = isTomlTable(parsed.projects) ? parsed.projects : {};
  projects[remoteProj] = { trust_level: "trusted" };
  parsed.projects = projects;
  return `${stringify(parsed)}\n`;
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
  profileEntries: (deps) => [
    ...[
      ".codex/AGENTS.md",
      ".codex/instructions.md",
      ".codex/prompts",
      ".codex/rules",
    ].filter((path) => deps.exists(`${deps.home}/${path}`)),
    ...CODEX_SKILLS_PATHS.flatMap((skillsPath) =>
      listPlainSkillDirs(deps, `${deps.home}/${skillsPath}`).map(
        (skill) => `${skillsPath}/${skill.name}`,
      ),
    ),
  ],
  externalSkills: (deps) =>
    CODEX_SKILLS_PATHS.flatMap((skillsPath) =>
      listSymlinkSkills(
        deps,
        `${deps.home}/${skillsPath}`,
        skillsPath,
        () => false,
      ),
    ),
  extraEnvRefs: (deps) => {
    const refs = new Set<string>();
    for (const skillsPath of CODEX_SKILLS_PATHS) {
      const skillsRoot = `${deps.home}/${skillsPath}`;
      for (const skill of listPlainSkillDirs(deps, skillsRoot))
        collectSkillDirEnvRefs(deps, refs, skill.dir);
      for (const skill of listSymlinkSkills(
        deps,
        skillsRoot,
        skillsPath,
        () => false,
      ))
        collectSkillDirEnvRefs(deps, refs, skill.realDir);
    }
    return uniqueSorted(refs);
  },
  prepareTranscript: (deps, bytes) => {
    const text = new TextDecoder().decode(bytes);
    const merged = mergeForkAncestry(deps, text);
    return merged === text ? bytes : new TextEncoder().encode(merged);
  },
  canResume: (bytes) => hasConversation(new TextDecoder().decode(bytes)),
  mcpConfigPaths: (home, cwd) => [
    `${home}/.codex/config.toml`,
    `${cwd}/.codex/config.toml`,
  ],
  mcpEnvRefs: readTomlEnvRefs,
  parseMcpServers,
  formatMcpConfig,
  authEnv,
  installCmd: (version) =>
    [
      `expected=${quote([version])}`,
      'current="$("$HOME/.local/bin/codex" --version 2>/dev/null || true)"',
      `case "$current" in *"$expected"*) : ;; *) NPM_CONFIG_PREFIX="$HOME/.local" npm i -g @openai/codex@${version} ;; esac`,
    ].join(" && "),
  supportsSettingsScripts: () => false,
  supportsReinstall: () => false,
  preSeed: (deps, remoteProj) => [
    buildNodeScript(
      buildHomeWriteScript(
        CODEX_CONFIG_PATH,
        buildPreSeededConfig(deps, remoteProj),
      ),
      "CODEX_PRESEED",
    ),
  ],
  remoteTranscriptPath: (home, remoteEnc, transcriptName) => {
    const { year, month, day } = parseCodexTranscriptName(transcriptName);
    return `${home}/.codex/sessions/${year}/${month}/${day}/${transcriptName}`;
  },
  projectMemoryPath: () => null,
  // Codex does not restore model_provider on resume (openai/codex#15219);
  // pin it from the session meta so azure-style sessions do not replay
  // provider-encrypted reasoning against the wrong endpoint.
  resumeCmd: (resume, remoteProj) => {
    if (resume === null) return `cd ${quote([remoteProj])} && codex`;
    const provider = readModelProvider(
      new TextDecoder().decode(resume.transcript),
    );
    const override =
      provider === null ? "" : ` -c model_provider=${quote([provider])}`;
    return `cd ${quote([remoteProj])} && codex${override} resume ${quote([resume.sessionId])}`;
  },
};
