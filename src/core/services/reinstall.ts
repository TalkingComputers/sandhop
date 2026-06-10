import {
  CLAUDE_INSTALLED_PLUGINS_PATH,
  CLAUDE_KNOWN_MARKETPLACES_PATH,
  CLAUDE_SETTINGS_PATH,
  CLAUDE_SKILLS_PATH,
  joinClaudeLocalPath,
} from "../../agents/claude-paths.js";
import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import { readJsonRecord } from "../json.js";
import { basename, dirname, listSkillNames } from "../paths.js";
import { quote } from "shell-quote";
import {
  type GitSkill,
  readGitSkillState,
  readSymlinkSource,
  toRemoteSkillPath,
} from "./git-skill.js";
import { buildCommandFor, installCommandFor } from "./install-cmd.js";
import { mapHomePath, type PathMapping } from "./mcp-paths.js";
import {
  readDisabledPlugins,
  readMarketplaceSource,
  readPluginInstalls,
} from "./reinstall-manifests.js";

export interface ReinstallPlan {
  commands: string[];
  mappings: PathMapping[];
}

const inRemoteDir = (remoteDir: string, cmd: string): string =>
  `cd ${quote([remoteDir])} && ${cmd}`;

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

const marketplaceRoot = (host: HostDeps, path: string): string => {
  if (host.isDirectory(path)) return path;
  const dir = dirname(path);
  return basename(dir) === ".claude-plugin" ? dirname(dir) : dir;
};

export class ReinstallService {
  readonly host: HostDeps;
  readonly agent: Agent;

  constructor(host: HostDeps, agent: Agent) {
    this.host = host;
    this.agent = agent;
  }

  private remoteSkillDir(sandboxHome: string, name: string): string {
    return `${sandboxHome}/${CLAUDE_SKILLS_PATH}/${name}`;
  }

  listMarketplaceCommands(sandboxHome: string): {
    commands: string[];
    mappings: PathMapping[];
  } {
    const path = joinClaudeLocalPath(
      this.host.home,
      CLAUDE_KNOWN_MARKETPLACES_PATH,
    );
    const record = readJsonRecord(this.host, path);
    if (record === null) return { commands: [], mappings: [] };
    const commands: string[] = [];
    const mappings: PathMapping[] = [];
    for (const name of Object.keys(record)) {
      const source = readMarketplaceSource(path, name, record[name]);
      if (source.kind === "remote") {
        commands.push(`claude plugin marketplace add ${quote([source.value])}`);
        continue;
      }
      if (!this.host.exists(source.path)) continue;
      const root = marketplaceRoot(this.host, source.path);
      const mapTo = (localPath: string): string =>
        mapHomePath(this.host.home, sandboxHome, localPath, "passthrough");
      mappings.push({ localPath: root, sandboxPath: mapTo(root) });
      commands.push(
        `claude plugin marketplace add ${quote([mapTo(source.path)])}`,
      );
    }
    return { commands, mappings };
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
        `claude plugin install ${quote([plugin.name])} --scope ${plugin.scope}`,
    );
  }

  listDisableCommands(): string[] {
    const path = joinClaudeLocalPath(this.host.home, CLAUDE_SETTINGS_PATH);
    const record = readJsonRecord(this.host, path);
    if (record === null) return [];
    return readDisabledPlugins(path, record).map(
      (plugin) => `claude plugin disable ${quote([plugin])}`,
    );
  }

  listGitSkillCommands(sandboxHome: string): {
    commands: string[];
    gitSkills: GitSkill[];
  } {
    const skillsRoot = joinClaudeLocalPath(this.host.home, CLAUDE_SKILLS_PATH);
    const commands: string[] = [];
    const gitSkills: GitSkill[] = [];
    for (const name of listSkillNames(this.host, skillsRoot)) {
      const localDir = `${skillsRoot}/${name}`;
      if (this.host.isSymlink(localDir)) continue;
      const gitDir = `${localDir}/.git`;
      if (!this.host.exists(gitDir)) continue;
      const remoteDir = this.remoteSkillDir(sandboxHome, name);
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
      const clone = `git clone ${quote([url])} ${quote([remoteDir])}`;
      const checkout = `git -C ${quote([remoteDir])} checkout ${quote([state.ref])}`;
      commands.push(`${clone} && ${checkout}`);
      commands.push(
        ...listInstallAndBuildCommands(this.host, localDir, remoteDir),
      );
    }
    return { commands, gitSkills };
  }

  listLocalSkillCommands(sandboxHome: string): string[] {
    const skillsRoot = joinClaudeLocalPath(this.host.home, CLAUDE_SKILLS_PATH);
    const commands: string[] = [];
    for (const name of listSkillNames(this.host, skillsRoot)) {
      const localDir = `${skillsRoot}/${name}`;
      if (this.host.isSymlink(localDir)) continue;
      if (!this.host.exists(`${localDir}/SKILL.md`)) continue;
      if (this.host.isSymlink(`${localDir}/SKILL.md`)) continue;
      if (this.host.exists(`${localDir}/.git`)) continue;
      commands.push(
        ...listInstallCommands(
          this.host,
          localDir,
          this.remoteSkillDir(sandboxHome, name),
        ),
      );
    }
    return commands;
  }

  listSymlinkSkillCommands(
    sandboxHome: string,
    gitSkills: GitSkill[],
  ): string[] {
    const skillsRoot = joinClaudeLocalPath(this.host.home, CLAUDE_SKILLS_PATH);
    const commands: string[] = [];
    for (const name of listSkillNames(this.host, skillsRoot)) {
      const skillDir = `${skillsRoot}/${name}`;
      const localSource = readSymlinkSource(this.host, skillDir);
      if (localSource === null) continue;
      const remoteSource = toRemoteSkillPath(localSource.localPath, gitSkills);
      const remoteSkillDir = this.remoteSkillDir(sandboxHome, name);
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
        const mkdir = `mkdir -p ${quote([dirname(remoteSkillDir)])}`;
        const link = `ln -sfn ${quote([remoteSource])} ${quote([remoteSkillDir])}`;
        commands.push(`${mkdir} && ${link}`);
      } else {
        const mkdir = `mkdir -p ${quote([remoteSkillDir])}`;
        const link = `ln -sf ${quote([remoteSource])} ${quote([`${remoteSkillDir}/SKILL.md`])}`;
        commands.push(`${mkdir} && ${link}`);
      }
    }
    return commands;
  }

  plan(sandboxHome: string): ReinstallPlan {
    if (!this.agent.supportsReinstall()) return { commands: [], mappings: [] };
    const gitSkillPlan = this.listGitSkillCommands(sandboxHome);
    const marketplacePlan = this.listMarketplaceCommands(sandboxHome);
    return {
      commands: [
        ...gitSkillPlan.commands,
        ...this.listLocalSkillCommands(sandboxHome),
        ...this.listSymlinkSkillCommands(sandboxHome, gitSkillPlan.gitSkills),
        ...marketplacePlan.commands,
        ...this.listPluginCommands(),
        ...this.listDisableCommands(),
      ],
      mappings: marketplacePlan.mappings,
    };
  }
}
