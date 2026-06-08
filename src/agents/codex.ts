import type { Agent, AgentHostDeps, AuthBundle } from "../core/ports/agent.js";
import {
  buildCodexPreSeedScript,
  renderNodeScript,
} from "../core/sandbox-scripts.js";
import { basename } from "../core/paths.js";
import { quote } from "shell-quote";
import { makeVersionParser, sortNewest } from "./shared.js";
import {
  formatMcpConfig,
  parseMcpServers,
  readTomlEnvRefs,
} from "./codex-mcp.js";
import {
  codexId,
  parseCodexTranscriptName,
  readRecordedCwd,
} from "./codex-session.js";

const parseVersion = makeVersionParser("codex");

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
    ...renderNodeScript(buildCodexPreSeedScript(remoteProj), "CODEX_PRESEED"),
  ],
  remoteTranscriptPath: (home, remoteEnc, transcriptName) => {
    const { year, month, day } = parseCodexTranscriptName(transcriptName);
    return `${home}/.codex/sessions/${year}/${month}/${day}/${transcriptName}`;
  },
  projectMemoryDir: () => null,
  resumeCmd: (sessionId, remoteProj) =>
    `cd ${quote([remoteProj])} && codex resume ${quote([sessionId])}`,
};
