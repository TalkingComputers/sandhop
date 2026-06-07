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
import { readJsonRecord } from "../json.js";
import { dirname, listSkillNames } from "../paths.js";
import { quoteShellPath, shellQuote } from "../shell.js";
import {
  type GitSkill,
  readGitSkillState,
  readSymlinkSource,
  toRemoteSkillPath,
} from "./git-skill.js";
import { buildCommandFor, installCommandFor } from "./install-cmd.js";
import {
  readDisabledPlugins,
  readMarketplaceSource,
  readPluginInstalls,
} from "./reinstall-manifests.js";

export interface ReinstallPlan {
  commands: string[];
}

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
    return readPluginInstalls(path, record).map(
      (plugin) =>
        `claude plugin install ${shellQuote(plugin.name)} --scope ${plugin.scope}`,
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
        ...gitSkillPlan.commands,
        ...this.listLocalSkillCommands(),
        ...this.listSymlinkSkillCommands(gitSkillPlan.gitSkills),
        ...this.listMarketplaceCommands(),
        ...this.listPluginCommands(),
        ...this.listDisableCommands(),
      ],
    };
  }
}
