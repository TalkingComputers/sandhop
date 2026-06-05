import {
  CLAUDE_INSTALLED_PLUGINS_PATH,
  CLAUDE_SETTINGS_PATH,
  CLAUDE_SKILLS_PATH,
  joinClaudeLocalPath,
} from "../../agents/claude-paths.js";
import { collectEnvRefs } from "../env.js";
import { isRecord } from "../json.js";
import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import { ProfileService } from "./profile.js";

export interface SecretsInputs {
  envRefs: string[];
  referencedFiles: string[];
}

export interface SecretsBundle {
  envs: Record<string, string>;
  files: { path: string; content: string }[];
}

export interface SecretsCollector {
  collect(
    cwd: string,
    inputs?: SecretsInputs,
  ): SecretsBundle | Promise<SecretsBundle>;
}

const SYSTEM_ENV_NAMES = new Set([
  "HOME",
  "PATH",
  "PWD",
  "OLDPWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "SHLVL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HOSTNAME",
  "MAIL",
  "_",
]);

const remotePath = (home: string, path: string): string => {
  if (path === home) return "$HOME";
  if (path.startsWith(`${home}/`)) return `$HOME${path.slice(home.length)}`;
  return path;
};

const readJsonRecord = (
  host: HostDeps,
  path: string,
): Record<string, unknown> | null => {
  const text = host.readFile(path);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const readDisabledPlugins = (host: HostDeps): Set<string> => {
  const settings = readJsonRecord(
    host,
    joinClaudeLocalPath(host.home, CLAUDE_SETTINGS_PATH),
  );
  const enabledPlugins = settings?.enabledPlugins;
  if (!isRecord(enabledPlugins)) return new Set();
  return new Set(
    Object.entries(enabledPlugins)
      .filter((entry): entry is [string, false] => entry[1] === false)
      .map(([name]) => name),
  );
};

const addEnvRefsFromText = (refs: Set<string>, text: string): void => {
  for (const name of collectEnvRefs(text)) refs.add(name);
};

const addPluginEnvRefs = (
  host: HostDeps,
  agent: Agent,
  refs: Set<string>,
): void => {
  if (agent.id !== "claude-code") return;
  const installed = readJsonRecord(
    host,
    joinClaudeLocalPath(host.home, CLAUDE_INSTALLED_PLUGINS_PATH),
  );
  const plugins = installed?.plugins;
  if (!isRecord(plugins)) return;
  const disabled = readDisabledPlugins(host);
  for (const [name, installs] of Object.entries(plugins)) {
    if (disabled.has(name) || !Array.isArray(installs)) continue;
    for (const install of installs) {
      if (!isRecord(install)) continue;
      const installPath = install.installPath;
      if (typeof installPath !== "string") continue;
      const text = host.readFile(`${installPath}/.mcp.json`);
      if (text === null) continue;
      for (const ref of agent.mcpEnvRefs(text)) refs.add(ref);
    }
  }
};

const addSkillDirEnvRefs = (
  host: HostDeps,
  refs: Set<string>,
  dir: string,
): void => {
  const skill = host.readFile(`${dir}/SKILL.md`);
  if (skill !== null) addEnvRefsFromText(refs, skill);
  const scripts = `${dir}/scripts`;
  if (!host.exists(scripts)) return;
  for (const path of host.walk(scripts)) {
    const text = host.readFile(path);
    if (text !== null) addEnvRefsFromText(refs, text);
  }
};

const addSkillEnvRefs = (
  host: HostDeps,
  agent: Agent,
  refs: Set<string>,
): void => {
  if (agent.id !== "claude-code") return;
  const profile = new ProfileService(host, agent);
  for (const entry of profile.listClaudeProfileEntries()) {
    if (!entry.startsWith(`${CLAUDE_SKILLS_PATH}/`)) continue;
    addSkillDirEnvRefs(host, refs, `${host.home}/${entry}`);
  }
  for (const skill of profile.listExternalSymlinkSkills())
    addSkillDirEnvRefs(host, refs, skill.realDir);
};

export class SecretsService implements SecretsCollector {
  readonly host: HostDeps;
  readonly agent: Agent;

  constructor(host: HostDeps, agent: Agent) {
    this.host = host;
    this.agent = agent;
  }

  collect(cwd: string, inputs?: SecretsInputs): SecretsBundle {
    const names = new Set<string>();
    for (const path of this.agent.mcpConfigPaths(this.host.home, cwd)) {
      const text = this.host.readFile(path);
      if (text === null) continue;
      for (const name of this.agent.mcpEnvRefs(text)) names.add(name);
    }
    addPluginEnvRefs(this.host, this.agent, names);
    addSkillEnvRefs(this.host, this.agent, names);
    if (inputs !== undefined) {
      for (const name of inputs.envRefs) names.add(name);
    }
    const envs: Record<string, string> = {};
    for (const name of [...names].sort()) {
      if (SYSTEM_ENV_NAMES.has(name)) continue;
      const value = this.host.env[name];
      if (value !== undefined) envs[name] = value;
    }
    const files: { path: string; content: string }[] = [];
    if (inputs !== undefined) {
      for (const path of [...inputs.referencedFiles].sort()) {
        const content = this.host.readFile(path);
        if (content === null)
          throw new Error(`Referenced MCP file not found: ${path}`);
        files.push({ path: remotePath(this.host.home, path), content });
      }
    }
    return { envs, files };
  }
}
