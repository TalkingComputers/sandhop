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
import { buildCommandFor, installCommandFor } from "./install-cmd.js";

export interface ReinstallPlan {
  commands: string[];
}

interface GitSkill {
  name: string;
  localDir: string;
  remoteDir: string;
}

export interface GitSkillState {
  copyRequired: boolean;
  ref: string | null;
}

const readLinkedPath = (path: string, target: string): string =>
  normalizePath(
    target.startsWith("/") ? target : joinPath(dirname(path), target),
  );

const readGitHead = (host: HostDeps, localDir: string): string =>
  host.exec("git", ["-C", localDir, "rev-parse", "HEAD"]).trim();

export const readGitSkillState = (
  host: HostDeps,
  localDir: string,
): GitSkillState => {
  if (host.exec("git", ["-C", localDir, "status", "--porcelain"]).trim())
    return { copyRequired: true, ref: null };
  const ref = readGitHead(host, localDir);
  return {
    copyRequired:
      host
        .exec("git", ["-C", localDir, "branch", "-r", "--contains", ref])
        .trim().length === 0,
    ref,
  };
};

const readJsonRecord = (
  host: HostDeps,
  path: string,
): Record<string, unknown> | null => {
  const text = host.readFile(path);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
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

interface SymlinkSkillSource {
  localPath: string;
  realDir: string;
  isDirectory: boolean;
}

const readSymlinkSource = (
  host: HostDeps,
  skillDir: string,
): SymlinkSkillSource | null => {
  if (host.isSymlink(skillDir)) {
    const target = readLinkedPath(skillDir, host.readlink(skillDir));
    const realPath = host.realpath(skillDir);
    const isDirectory = host.isDirectory(realPath);
    return {
      localPath: isDirectory
        ? target
        : target.endsWith("/SKILL.md")
          ? target
          : `${target}/SKILL.md`,
      realDir: isDirectory ? realPath : dirname(realPath),
      isDirectory,
    };
  }
  const skillFile = `${skillDir}/SKILL.md`;
  if (host.exists(skillFile) && host.isSymlink(skillFile))
    return {
      localPath: readLinkedPath(skillFile, host.readlink(skillFile)),
      realDir: dirname(host.realpath(skillFile)),
      isDirectory: false,
    };
  return null;
};

const inRemoteDir = (remoteDir: string, cmd: string): string =>
  `cd ${quoteShellPath(remoteDir)} && ${cmd}`;

const listInstallAndBuildCommands = (
  host: HostDeps,
  localDir: string,
  remoteDir: string,
): string[] => {
  const commands: string[] = [];
  const installCommand = installCommandFor(host, localDir);
  if (installCommand !== null)
    commands.push(inRemoteDir(remoteDir, installCommand));
  const buildCommand = buildCommandFor(host, localDir);
  if (buildCommand !== null)
    commands.push(inRemoteDir(remoteDir, buildCommand));
  return commands;
};

const listInstallCommands = (
  host: HostDeps,
  localDir: string,
  remoteDir: string,
): string[] => {
  const installCommand = installCommandFor(host, localDir);
  return installCommand === null
    ? []
    : [inRemoteDir(remoteDir, installCommand)];
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
      gitSkills.push({ name, localDir, remoteDir });
      const state = readGitSkillState(this.host, localDir);
      if (state.copyRequired) {
        commands.push(...listInstallCommands(this.host, localDir, remoteDir));
        continue;
      }
      if (state.ref === null)
        throw new Error(`Missing git HEAD for ${localDir}`);
      const url = this.host
        .exec("git", ["-C", localDir, "config", "--get", "remote.origin.url"])
        .trim();
      const clone = `git clone ${shellQuote(url)} ${quoteShellPath(remoteDir)}`;
      const checkout = `git -C ${quoteShellPath(remoteDir)} checkout ${shellQuote(state.ref)}`;
      commands.push(`${clone} && ${checkout}`);
      commands.push(
        ...listInstallAndBuildCommands(this.host, localDir, remoteDir),
      );
    }
    return { commands, gitSkills };
  }

  listLocalSkillCommands(): string[] {
    const skillsRoot = joinClaudeLocalPath(this.host.home, CLAUDE_SKILLS_PATH);
    const commands: string[] = [];
    for (const name of listSkillNames(this.host, skillsRoot)) {
      const localDir = `${skillsRoot}/${name}`;
      if (this.host.isSymlink(localDir)) continue;
      if (!this.host.exists(`${localDir}/SKILL.md`)) continue;
      if (this.host.isSymlink(`${localDir}/SKILL.md`)) continue;
      if (this.host.exists(`${localDir}/.git`)) continue;
      const remoteDir = joinClaudeHomePath(`${CLAUDE_SKILLS_PATH}/${name}`);
      commands.push(...listInstallCommands(this.host, localDir, remoteDir));
    }
    return commands;
  }

  listSymlinkSkillCommands(gitSkills: GitSkill[]): string[] {
    const skillsRoot = joinClaudeLocalPath(this.host.home, CLAUDE_SKILLS_PATH);
    const commands: string[] = [];
    for (const name of listSkillNames(this.host, skillsRoot)) {
      const skillDir = `${skillsRoot}/${name}`;
      const localSource = readSymlinkSource(this.host, skillDir);
      if (localSource === null) continue;
      const remoteSource = toRemoteSkillPath(localSource.localPath, gitSkills);
      const remoteSkillDir = joinClaudeHomePath(
        `${CLAUDE_SKILLS_PATH}/${name}`,
      );
      if (remoteSource === null) {
        commands.push(
          ...listInstallCommands(
            this.host,
            localSource.realDir,
            remoteSkillDir,
          ),
        );
        continue;
      }
      if (localSource.isDirectory) {
        const mkdir = `mkdir -p ${quoteShellPath(dirname(remoteSkillDir))}`;
        const link = `ln -sfn ${quoteShellPath(remoteSource)} ${quoteShellPath(
          remoteSkillDir,
        )}`;
        commands.push(`${mkdir} && ${link}`);
      } else {
        const mkdir = `mkdir -p ${quoteShellPath(remoteSkillDir)}`;
        const link = `ln -sf ${quoteShellPath(remoteSource)} ${quoteShellPath(
          `${remoteSkillDir}/SKILL.md`,
        )}`;
        commands.push(`${mkdir} && ${link}`);
      }
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
        ...this.listLocalSkillCommands(),
        ...this.listSymlinkSkillCommands(gitSkillPlan.gitSkills),
      ],
    };
  }
}
