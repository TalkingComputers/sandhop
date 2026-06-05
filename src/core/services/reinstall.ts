import {
  CLAUDE_INSTALLED_PLUGINS_PATH,
  CLAUDE_KNOWN_MARKETPLACES_PATH,
  CLAUDE_SETTINGS_PATH,
  CLAUDE_SKILLS_PATH,
  joinClaudeHomePath,
  joinClaudeLocalPath,
} from "../../agents/claude-paths.js";
import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import { isRecord } from "../json.js";
import { dirname, joinPath, listSkillNames, normalizePath } from "../paths.js";
import { quoteShellPath, shellQuote } from "../shell.js";

export interface ReinstallPlan {
  commands: string[];
}

interface GitSkill {
  name: string;
  localDir: string;
  remoteDir: string;
}

const readLinkedPath = (path: string, target: string): string =>
  normalizePath(
    target.startsWith("/") ? target : joinPath(dirname(path), target),
  );

const readJsonRecord = (
  host: HostDeps,
  path: string,
): Record<string, unknown> | null => {
  const text = host.readFile(path);
  if (text === null) return null;
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) throw new Error(`Expected JSON object at ${path}`);
  return parsed;
};

const readMarketplaceSource = (
  path: string,
  name: string,
  value: unknown,
): string => {
  if (!isRecord(value)) throw new Error(`Expected marketplace object ${name}`);
  const source = value.source;
  if (!isRecord(source)) throw new Error(`Expected marketplace source ${name}`);
  const repo = source.repo;
  if (typeof repo === "string") return repo;
  const url = source.url;
  if (typeof url === "string") return url;
  throw new Error(`Expected marketplace repo or url in ${path} for ${name}`);
};

const readPluginKeys = (path: string, value: unknown): string[] => {
  if (!isRecord(value))
    throw new Error(`Expected installed plugins object at ${path}`);
  const plugins = value.plugins;
  if (!isRecord(plugins)) throw new Error(`Expected plugins map at ${path}`);
  return Object.keys(plugins);
};

const readDisabledPlugins = (path: string, value: unknown): string[] => {
  if (!isRecord(value)) throw new Error(`Expected settings object at ${path}`);
  const enabled = value.enabledPlugins;
  if (enabled === undefined) return [];
  if (!isRecord(enabled))
    throw new Error(`Expected enabledPlugins object at ${path}`);
  return Object.entries(enabled)
    .map(([name, state]) => {
      if (state === false) return name;
      if (state === true) return null;
      throw new Error(`Expected boolean enabledPlugins.${name} at ${path}`);
    })
    .filter((name): name is string => name !== null);
};

const toRemoteSkillPath = (
  localPath: string,
  gitSkills: GitSkill[],
): string | null => {
  for (const skill of gitSkills) {
    if (localPath === skill.localDir) return skill.remoteDir;
    if (localPath.startsWith(`${skill.localDir}/`))
      return `${skill.remoteDir}${localPath.slice(skill.localDir.length)}`;
  }
  return null;
};

const readSymlinkSource = (host: HostDeps, skillDir: string): string | null => {
  if (host.isSymlink(skillDir)) {
    const target = readLinkedPath(skillDir, host.readlink(skillDir));
    return target.endsWith("/SKILL.md") ? target : `${target}/SKILL.md`;
  }
  const skillFile = `${skillDir}/SKILL.md`;
  if (host.exists(skillFile) && host.isSymlink(skillFile))
    return readLinkedPath(skillFile, host.readlink(skillFile));
  return null;
};

export class ReinstallService {
  readonly host: HostDeps;
  readonly agent: Agent;

  constructor(host: HostDeps, agent: Agent) {
    this.host = host;
    this.agent = agent;
  }

  listMarketplaceCommands(): string[] {
    const path = joinClaudeLocalPath(
      this.host.home,
      CLAUDE_KNOWN_MARKETPLACES_PATH,
    );
    const record = readJsonRecord(this.host, path);
    if (record === null) return [];
    return Object.keys(record).map(
      (name) =>
        `claude plugin marketplace add ${shellQuote(readMarketplaceSource(path, name, record[name]))}`,
    );
  }

  listPluginCommands(): string[] {
    const path = joinClaudeLocalPath(
      this.host.home,
      CLAUDE_INSTALLED_PLUGINS_PATH,
    );
    const record = readJsonRecord(this.host, path);
    if (record === null) return [];
    return readPluginKeys(path, record).map(
      (plugin) => `claude plugin install ${shellQuote(plugin)} --scope user`,
    );
  }

  listDisableCommands(): string[] {
    const path = joinClaudeLocalPath(this.host.home, CLAUDE_SETTINGS_PATH);
    const record = readJsonRecord(this.host, path);
    if (record === null) return [];
    return readDisabledPlugins(path, record).map(
      (plugin) => `claude plugin disable ${shellQuote(plugin)}`,
    );
  }

  listGitSkillCommands(): { commands: string[]; gitSkills: GitSkill[] } {
    const skillsRoot = joinClaudeLocalPath(this.host.home, CLAUDE_SKILLS_PATH);
    const commands: string[] = [];
    const gitSkills: GitSkill[] = [];
    for (const name of listSkillNames(this.host, skillsRoot)) {
      const localDir = `${skillsRoot}/${name}`;
      if (this.host.isSymlink(localDir)) continue;
      const gitDir = `${localDir}/.git`;
      if (!this.host.exists(gitDir)) continue;
      const remoteDir = joinClaudeHomePath(`${CLAUDE_SKILLS_PATH}/${name}`);
      const url = this.host
        .exec("git", ["-C", localDir, "config", "--get", "remote.origin.url"])
        .trim();
      const ref = this.host
        .exec("git", ["-C", localDir, "rev-parse", "HEAD"])
        .trim();
      gitSkills.push({ name, localDir, remoteDir });
      const clone = `git clone ${shellQuote(url)} ${quoteShellPath(remoteDir)}`;
      const checkout = `git -C ${quoteShellPath(remoteDir)} checkout ${shellQuote(ref)}`;
      commands.push(`${clone} && ${checkout}`);
    }
    return { commands, gitSkills };
  }

  listSymlinkSkillCommands(gitSkills: GitSkill[]): string[] {
    const skillsRoot = joinClaudeLocalPath(this.host.home, CLAUDE_SKILLS_PATH);
    const commands: string[] = [];
    for (const name of listSkillNames(this.host, skillsRoot)) {
      const skillDir = `${skillsRoot}/${name}`;
      const localSource = readSymlinkSource(this.host, skillDir);
      if (localSource === null) continue;
      const remoteSource = toRemoteSkillPath(localSource, gitSkills);
      if (remoteSource === null) continue;
      const remoteSkillDir = joinClaudeHomePath(
        `${CLAUDE_SKILLS_PATH}/${name}`,
      );
      const mkdir = `mkdir -p ${quoteShellPath(remoteSkillDir)}`;
      const link = `ln -sf ${quoteShellPath(remoteSource)} ${quoteShellPath(`${remoteSkillDir}/SKILL.md`)}`;
      commands.push(`${mkdir} && ${link}`);
    }
    return commands;
  }

  plan(): ReinstallPlan {
    if (!this.agent.supportsReinstall()) return { commands: [] };
    const gitSkillPlan = this.listGitSkillCommands();
    return {
      commands: [
        ...this.listMarketplaceCommands(),
        ...this.listPluginCommands(),
        ...this.listDisableCommands(),
        ...gitSkillPlan.commands,
        ...this.listSymlinkSkillCommands(gitSkillPlan.gitSkills),
      ],
    };
  }
}
